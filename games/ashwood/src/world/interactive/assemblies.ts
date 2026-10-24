import { Box3, CanvasTexture, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SRGBColorSpace, TorusGeometry, Vector3, type Object3D } from "three/webgpu"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import { floorWorldY } from "../interior/plan"
import { InteractiveProp, type Item } from "./prop"
import type { Terminal } from "./terminal"

export type Placement = { id: string; storey: number; x: number; z: number; yaw?: number; height?: number }
type Finish = "steel" | "inside" | "brass" | "paper" | "wood" | "rubber"
const FINISH: Record<Finish, [number, number, number]> = { steel: [0x50584e, 0.68, 0.45], inside: [0x3d423b, 0.82, 0.2], brass: [0x9a834a, 0.4, 0.85], paper: [0xc1b697, 0.94, 0], wood: [0x534332, 0.85, 0], rubber: [0x363936, 0.9, 0] }

function start(p: Placement) {
  const prop = new InteractiveProp(p.id, p.storey)
  prop.root.position.set(p.x, floorWorldY(p.storey) + (p.height ?? 0), p.z)
  prop.root.rotation.y = p.yaw ?? 0
  return prop
}

function material(finish: Finish) {
  const [color, roughness, metalness] = FINISH[finish]
  const m = new MeshStandardMaterial({ color, roughness, metalness })
  m.name = `interactive:${finish}`
  return m
}

function box(prop: InteractiveProp, parent: Object3D, size: [number, number, number], at: [number, number, number], finish: Finish = "steel", solid = true) {
  const mesh = new Mesh(new RoundedBoxGeometry(...size, 2, Math.min(0.008, Math.min(...size) / 4)), material(finish))
  mesh.position.set(...at)
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  if (solid) prop.solids.push(mesh)
  return mesh
}

function label(prop: InteractiveProp, parent: Object3D, text: string, at: [number, number, number], width = 0.16) {
  const plate = box(prop, parent, [width, 0.045, 0.004], at, "paper", false)
  if (typeof document === "undefined") return plate
  const canvas = document.createElement("canvas")
  canvas.width = 512; canvas.height = 128
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#bdb292"; ctx.fillRect(0, 0, 512, 128)
  ctx.fillStyle = "#282b25"; ctx.font = "bold 70px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"
  ctx.fillText(text, 256, 64, 480)
  const map = new CanvasTexture(canvas); map.colorSpace = SRGBColorSpace
  plate.material.map = map
  plate.material.name = `interactive:label:${text}`
  plate.material.color.set(0xffffff)
  plate.material.addEventListener("dispose", () => map.dispose())
  return plate
}

function pull(prop: InteractiveProp, parent: Object3D, x: number, y: number, z: number) {
  for (const dx of [-0.065, 0.065]) box(prop, parent, [0.018, 0.018, 0.025], [x + dx, y, z], "brass", false)
  return box(prop, parent, [0.15, 0.018, 0.018], [x, y, z + 0.018], "brass", false)
}

/** Open carcass: collision is the individual sheets, leaving a real accessible interior. Front faces local +Z. */
function carcass(prop: InteractiveProp, parent: Object3D, w: number, h: number, d: number) {
  for (const x of [-w / 2, w / 2]) box(prop, parent, [0.025, h, d], [x, h / 2, 0])
  for (const y of [0.025, h - 0.025]) box(prop, parent, [w, 0.025, d], [0, y, 0])
  box(prop, parent, [w, h, 0.025], [0, h / 2, -d / 2])
}

/** Socket geometry remains parented to the moving tray/door, so contents travel with it. */
export function itemSocket(prop: InteractiveProp, parent: Object3D, id: string, item: Item, at: [number, number, number], part?: string, hanging = false) {
  const node = new Group(); node.position.set(...at); parent.add(node)
  if (item.kind === "key") {
    const bow = new Mesh(new TorusGeometry(0.015, 0.004, 6, 16), material("brass")); node.add(bow)
    box(prop, node, [0.007, 0.045, 0.006], [0, -0.033, 0], "brass", false)
    box(prop, node, [0.018, 0.007, 0.006], [0.006, -0.05, 0], "brass", false)
    if (!hanging) node.rotation.x = -Math.PI / 2
  } else if (item.kind === "badge") {
    box(prop, node, [0.055, 0.004, 0.085], [0, 0.003, 0], "paper", false)
    box(prop, node, [0.02, 0.002, 0.026], [-0.012, 0.006, -0.014], "rubber", false)
  } else {
    if (item.kind === "clipboard") box(prop, node, [0.23, 0.008, 0.32], [0, 0, 0], "wood", false)
    box(prop, node, [0.21, 0.002, 0.29], [0, 0.006, 0], "paper", false)
    for (let i = 0; i < 7; i++) box(prop, node, [0.16, 0.001, 0.002], [0, 0.008, -0.1 + i * 0.027], "inside", false)
    if (item.kind === "clipboard") box(prop, node, [0.07, 0.012, 0.025], [0, 0.012, -0.14], "brass", false)
  }
  return prop.socket(id, node, item, part)
}

function drawer(prop: InteractiveProp, parent: Object3D, id: string, text: string, x: number, y: number, w: number, h: number, d: number) {
  const tray = new Group(); tray.position.set(x, y, 0); parent.add(tray)
  box(prop, tray, [w, 0.018, d], [0, 0, 0], "inside")
  for (const xx of [-w / 2, w / 2]) box(prop, tray, [0.014, h, d], [xx, h / 2, 0], "inside")
  box(prop, tray, [w, h, 0.018], [0, h / 2, -d / 2], "inside")
  box(prop, tray, [w + 0.02, h + 0.015, 0.025], [0, h / 2, d / 2])
  const handle = pull(prop, tray, 0, h * 0.65, d / 2 + 0.025)
  label(prop, tray, text, [0, h * 0.3, d / 2 + 0.016])
  prop.part(id, text, tray, { kind: "slide", offset: new Vector3(0, 0, d * 0.85) }, handle)
  return tray
}

export function filingCabinet(p: Placement, contents: Item[] = []) {
  const prop = start(p)
  carcass(prop, prop.root, 0.52, 1.25, 0.66)
  for (const [i, text] of ["A-G", "H-M", "N-Z"].entries()) {
    const id = `drawer-${i}`, tray = drawer(prop, prop.root, id, text, 0, 0.09 + (2 - i) * 0.38, 0.46, 0.33, 0.6)
    if (contents[i]) itemSocket(prop, tray, id, contents[i], [0, 0.025, 0.06], id)
  }
  return prop
}

export function desk(p: Placement, contents: Item[] = []) {
  const prop = start(p)
  box(prop, prop.root, [1.5, 0.045, 0.78], [0, 0.76, 0], "wood")
  for (const z of [-0.33, 0.33]) box(prop, prop.root, [0.035, 0.72, 0.035], [0.69, 0.36, z])
  const pedestal = new Group(); pedestal.position.x = -0.48; prop.root.add(pedestal)
  carcass(prop, pedestal, 0.46, 0.72, 0.72)
  for (let i = 0; i < 3; i++) {
    const id = `drawer-${i}`, tray = drawer(prop, pedestal, id, `DESK ${i + 1}`, 0, 0.08 + i * 0.21, 0.4, 0.17, 0.66)
    if (contents[i]) itemSocket(prop, tray, id, contents[i], [0, 0.024, 0.05], id)
  }
  return prop
}

function swingingDoor(prop: InteractiveProp, w: number, h: number, d: number, text: string, key?: string) {
  const hinge = new Group(); hinge.position.set(-w / 2, 0, d / 2); prop.root.add(hinge)
  box(prop, hinge, [w - 0.025, h - 0.06, 0.025], [w / 2, h / 2, 0])
  const handle = pull(prop, hinge, w - 0.13, h * 0.5, 0.035)
  label(prop, hinge, text, [w / 2, h * 0.8, 0.017], Math.min(w * 0.7, 0.25))
  prop.part("door", text, hinge, { kind: "hinge", axis: "y", angle: -Math.PI * 0.62 }, handle, key)
  return hinge
}

export function locker(p: Placement & { number: number }, contents: Item[] = []) {
  const prop = start(p)
  carcass(prop, prop.root, 0.9, 2.05, 0.9)
  const leaf = swingingDoor(prop, 0.9, 2.05, 0.9, String(p.number).padStart(2, "0"))
  for (let i = 0; i < 4; i++) box(prop, leaf, [0.25, 0.012, 0.003], [0.45, 1.72 + i * 0.035, 0.016], "inside", false)
  box(prop, prop.root, [0.84, 0.025, 0.84], [0, 1.84, 0], "inside")
  prop.hideVolume = new Box3(new Vector3(-0.4, -0.01, -0.4), new Vector3(0.4, 1.8, 0.39))
  contents.forEach((item, i) => itemSocket(prop, prop.root, `shelf-${i}`, item, [-0.23 + i * 0.23, 1.87, 0.08], "door"))
  // An inside pull can be reached without aiming through the closed door.
  const handle = pull(prop, leaf, 0.7, 0.95, -0.06)
  prop.targets.push({ id: `${p.id}/inside-pull`, node: handle, label: () => prop.parts.get("door")!.target ? "Close locker" : "Open locker", use: () => prop.toggle("door"), available: () => true })
  return prop
}

/** Paired doors share a walk-in compartment while retaining the original bank's width and numbering. */
export function lockerBank(p: Placement, count: number, first: number, contents: (number: number) => Item[]) {
  const prop = start(p), width = count * 0.38, depth = 0.8
  carcass(prop, prop.root, width, 1.92, depth)
  for (let i = 0; i < count; i++) {
    const number = first + count - 1 - i, id = `locker-${number}`, x = -width / 2 + i * 0.38
    const right = i % 2 === 1
    const pivot = new Group(); pivot.position.set(x + (right ? 0.38 : 0), 0, depth / 2); pivot.scale.x = right ? -1 : 1; prop.root.add(pivot)
    box(prop, pivot, [0.36, 1.82, 0.02], [0.19, 0.97, 0])
    const handle = pull(prop, pivot, 0.27, 1.05, 0.035)
    label(prop, pivot, String(number), [0.19, 1.72, 0.013], 0.1)
    for (let k = 0; k < 4; k++) box(prop, pivot, [0.23, 0.009, 0.004], [0.19, 1.5 + k * 0.03, 0.013], "inside", false)
    prop.part(id, `locker ${number}`, pivot, { kind: "hinge", axis: "y", angle: (right ? 1 : -1) * Math.PI * 0.6 }, handle)
    const inside = pull(prop, pivot, 0.27, 1.05, -0.06)
    prop.targets.push({ id: `${p.id}/${id}/inside`, node: inside, label: () => `${prop.parts.get(id)!.target ? "Close" : "Open"} locker ${number}`, use: () => prop.toggle(id), available: () => true })
    contents(number).forEach((item, j) => itemSocket(prop, prop.root, `${id}-${j}`, item, [x + 0.19, 0.07, -0.22 + j * 0.15], id))
    if (i % 2 === 0 && i + 1 < count) {
      prop.hidingCompartments.push({ volume: new Box3(new Vector3(x + 0.026, -0.01, -0.36), new Vector3(x + 0.734, 1.84, 0.36)), doors: [id, `locker-${number - 1}`] })
      if (i > 0) box(prop, prop.root, [0.018, 1.84, depth], [x, 0.96, 0])
    }
  }
  return prop
}

export function keyCabinet(p: Placement & { key?: string }, keys: { number: number; item: Item }[]) {
  if (new Set(keys.map(k => k.number)).size !== keys.length || keys.some(k => !Number.isInteger(k.number) || k.number < 1 || k.number > 10)) throw new Error("Key cabinet hooks must be unique numbers 1–10")
  const prop = start(p)
  carcass(prop, prop.root, 0.62, 0.75, 0.14)
  swingingDoor(prop, 0.62, 0.75, 0.14, "KEY REGISTER", p.key)
  for (let i = 0; i < 10; i++) {
    const x = -0.24 + (i % 5) * 0.12, y = 0.57 - Math.floor(i / 5) * 0.29
    label(prop, prop.root, String(i + 1), [x, y + 0.075, -0.047], 0.08)
    box(prop, prop.root, [0.008, 0.008, 0.045], [x, y, -0.025], "brass", false)
    const key = keys.find(k => k.number === i + 1)
    if (key) itemSocket(prop, prop.root, `hook-${i + 1}`, key.item, [x, y - 0.01, 0.003], "door", true)
  }
  return prop
}

export function wallSafe(p: Placement & { combination: readonly [number, number, number] }, contents: Item[] = []) {
  if (p.combination.some(n => !Number.isInteger(n) || n < 0 || n > 9)) throw new Error("Safe combination must contain three digits")
  const prop = start(p)
  carcass(prop, prop.root, 0.62, 0.6, 0.38)
  const leaf = swingingDoor(prop, 0.62, 0.6, 0.38, "SECURITY")
  prop.combination = p.combination
  const wheels: Mesh[] = []
  for (let i = 0; i < 3; i++) {
    const wheel = new Mesh(new CylinderGeometry(0.028, 0.028, 0.04, 20), material("brass"))
    wheel.rotation.x = Math.PI / 2; wheel.position.set(0.2 + i * 0.07, 0.3, 0.04); leaf.add(wheel)
    wheels.push(wheel)
    prop.targets.push({ id: `${p.id}/dial-${i}`, node: wheel, label: () => `Dial ${i + 1}: ${prop.digits[i]}`, available: () => prop.parts.get("door")!.amount < 0.08,
      use: () => { prop.digits[i] = (prop.digits[i] + 1) % 10; wheel.rotation.y = prop.digits[i] * Math.PI / 5; return true } })
  }
  prop.onRestore = () => wheels.forEach((wheel, i) => { wheel.rotation.y = prop.digits[i] * Math.PI / 5 })
  contents.forEach((item, i) => itemSocket(prop, prop.root, `safe-${i}`, item, [-0.16 + i * 0.16, 0.055, 0], "door"))
  return prop
}

export function breaker(p: Placement, onChange: (on: boolean) => void) {
  const prop = start(p)
  box(prop, prop.root, [0.36, 0.55, 0.1], [0, 0.275, 0])
  label(prop, prop.root, `FLOOR ${p.storey}`, [0, 0.46, 0.054], 0.25)
  const pivot = new Group(); pivot.position.set(0, 0.25, 0.07); prop.root.add(pivot)
  const handle = box(prop, pivot, [0.11, 0.18, 0.06], [0, 0.06, 0.02], "rubber", false)
  prop.part("switch", "breaker", pivot, { kind: "hinge", axis: "x", angle: Math.PI / 3 }, handle)
  const target = prop.targets[0]
  target.label = () => prop.powered ? "Switch floor power off" : "Switch floor power on"
  target.use = () => { if (!prop.toggle("switch")) return false; prop.powered = prop.parts.get("switch")!.target === 0; onChange(prop.powered); return true }
  prop.onRestore = () => onChange(prop.powered)
  return prop
}

export function mobileShelving(p: Placement, travel = 1.15, length = 2.1) {
  if (!Number.isFinite(travel) || travel <= 0) throw new Error("Shelving travel must be positive")
  const prop = start(p)
  for (const z of [-length * 0.4, length * 0.4]) box(prop, prop.root, [travel + 0.85, 0.012, 0.035], [travel / 2, 0.008, z], "brass", false)
  const carriage = new Group(); prop.root.add(carriage)
  for (const x of [-0.37, 0.37]) box(prop, carriage, [0.025, 2.2, length], [x, 1.13, 0])
  for (let y = 0.05; y <= 2.2; y += 0.43) {
    box(prop, carriage, [0.74, 0.025, length], [0, y, 0], "inside")
    if (y < 2) for (let z = -length / 2 + 0.3; z < length / 2 - 0.2; z += 0.48) box(prop, carriage, [0.56, 0.29, 0.4], [0, y + 0.16, z], "paper", false)
  }
  box(prop, carriage, [0.74, 2.2, 0.025], [0, 1.13, length / 2])
  const wheel = new Mesh(new TorusGeometry(0.16, 0.012, 8, 32), material("brass")); wheel.position.set(0, 1.1, length / 2 + 0.07); carriage.add(wheel)
  for (let i = 0; i < 3; i++) { const spoke = box(prop, wheel, [0.31, 0.012, 0.012], [0, 0, 0], "brass", false); spoke.rotation.z = i * Math.PI / 3 }
  prop.part("carriage", "shelving aisle", carriage, { kind: "slide", offset: new Vector3(travel, 0, 0) }, wheel)
  label(prop, carriage, "MOBILE RECORDS", [0, 1.55, length / 2 + 0.018], 0.5)
  const update = prop.update.bind(prop)
  prop.update = dt => { update(dt); wheel.rotation.z = prop.parts.get("carriage")!.amount * Math.PI * 4 }
  return prop
}

export function terminalHousing(p: Placement, terminal: Terminal) {
  const prop = start(p)
  box(prop, prop.root, [0.52, 0.35, 0.42], [0, 0.25, -0.025], "inside")
  box(prop, prop.root, [0.23, 0.08, 0.22], [0, 0.04, 0], "steel")
  // The native ScreenQuadPass fills this recessed face, separately from the opaque housing.
  for (const x of [-0.245, 0.245]) box(prop, prop.root, [0.03, 0.35, 0.035], [x, 0.25, 0.198], "steel", false)
  for (const y of [0.09, 0.41]) box(prop, prop.root, [0.49, 0.03, 0.035], [0, y, 0.198], "steel", false)
  const keyboard = box(prop, prop.root, [0.5, 0.035, 0.2], [0, 0.025, 0.39], "inside")
  for (let row = 0; row < 4; row++) for (let col = 0; col < 12; col++) box(prop, prop.root, [0.03, 0.012, 0.032], [-0.21 + col * 0.038, 0.05, 0.32 + row * 0.043], "steel", false)
  prop.targets.push({ id: `${p.id}/terminal`, node: keyboard, label: () => "Use terminal", available: () => terminal.services.powered(), use: () => terminal.enter() })
  const glass = new Group(); glass.position.set(0, 0.25, 0.216); prop.root.add(glass)
  prop.root.updateWorldMatrix(true, true)
  return { prop, glass, terminal, placement: { center: glass.getWorldPosition(new Vector3()).toArray() as [number, number, number], yaw: Math.PI / 2 - (p.yaw ?? 0), width: 0.46, height: 0.29 } }
}
