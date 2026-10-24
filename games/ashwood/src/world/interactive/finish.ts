import { BufferGeometry, CanvasTexture, Float32BufferAttribute, Matrix3, Matrix4, Mesh, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, Vector3, type Material, type Object3D } from "three/webgpu"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { material as library, materialFor, weatheredSteel } from "../../render/materials"
import type { InteractiveProp } from "./prop"

// Finishes for the interactive containers (concept: the dark storey sets). Sheet steel is the shared `weathered`
// library class (painted-metal scan, chips, rust, grime, baked vertex AO); paper, card, folders, cloth and laminate are
// small canvases drawn once. Every material here is shared between props (`userData.shared`), so disposing a prop
// leaves them alone; `metreUV` marks materials whose geometry gets box-projected UVs in metres.

export const BROWSER = typeof document !== "undefined"

export type Finish =
  | "steel" | "inside" | "locker" | "lockerInside" | "safe" | "safeInside" | "enamel" | "board"
  | "chrome" | "brass" | "nickel" | "rubber" | "slot" | "putty" | "keycap" | "keycapDark"
  | "wood" | "paper" | "manila" | "pressboard" | "tabs" | "hardboard" | "coat" | "jacket" | "leather" | "redFob"
  | "pencil" | "eraser" | "led"

type AO = (p: Vector3, n: Vector3) => number

export function rng(seed: number) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
}

export function hashString(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, repeat = false) {
  const c = document.createElement("canvas")
  c.width = w; c.height = h
  draw(c.getContext("2d")!, w, h)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 8
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping
  return t
}

/** Speckle, fibre and blotch noise over whatever is already drawn. */
function grain(g: CanvasRenderingContext2D, w: number, h: number, seed: number, amount = 1) {
  const r = rng(seed)
  for (let i = 0; i < w * h * 0.02 * amount; i++) {
    g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${0.05 * r()})` : `rgba(255,250,235,${0.05 * r()})`
    g.fillRect(r() * w, r() * h, 1 + r() * 2, 1)
  }
  for (let i = 0; i < 18 * amount; i++) {
    const x = r() * w, y = r() * h, rad = (0.05 + r() * 0.2) * Math.min(w, h)
    const gr = g.createRadialGradient(x, y, 0, x, y, rad)
    gr.addColorStop(0, `rgba(60,40,15,${0.05 + r() * 0.08})`)
    gr.addColorStop(1, "rgba(60,40,15,0)")
    g.fillStyle = gr
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2)
  }
}

function ring(g: CanvasRenderingContext2D, x: number, y: number, rad: number, alpha: number) {
  g.strokeStyle = `rgba(80,45,15,${alpha})`
  g.lineWidth = rad * 0.08
  g.beginPath(); g.arc(x, y, rad, 0.3, Math.PI * 2 - 0.2); g.stroke()
  g.strokeStyle = `rgba(80,45,15,${alpha * 0.4})`
  g.lineWidth = rad * 0.25
  g.beginPath(); g.arc(x, y, rad * 0.92, 0, Math.PI * 2); g.stroke()
}

const textures = {
  manila: () => canvas(512, 512, (g, w, h) => {
    g.fillStyle = "#8f8470"; g.fillRect(0, 0, w, h)
    grain(g, w, h, 11, 2)
    // Handled top edge and a scuffed fold line.
    const top = g.createLinearGradient(0, 0, 0, h * 0.18)
    top.addColorStop(0, "rgba(55,35,10,0.45)"); top.addColorStop(1, "rgba(55,35,10,0)")
    g.fillStyle = top; g.fillRect(0, 0, w, h * 0.18)
    g.fillStyle = "rgba(40,25,8,0.25)"; g.fillRect(0, h - 6, w, 6)
    ring(g, w * 0.7, h * 0.62, 46, 0.22)
  }),
  label: () => canvas(256, 64, (g, w, h) => {
    g.fillStyle = "#d9d2bd"; g.fillRect(0, 0, w, h)
    const r = rng(5)
    g.fillStyle = "rgba(30,30,35,0.8)"; g.font = "bold 22px 'Courier New', monospace"; g.textBaseline = "middle"
    const words = ["HARGROVE R", "PAYROLL 84", "N. ARRAY", "SITE SURV", "INCIDENT", "VEHICLES", "STAFF FILE", "PERSONNEL"]
    for (let i = 0; i < 4; i++) g.fillText(words[Math.floor(r() * words.length)], 8 + (i % 2) * 128, 18 + Math.floor(i / 2) * 30, 116)
    grain(g, w, h, 6, 1)
  }),
  pressboard: () => canvas(1024, 64, (g, w, h) => {
    const cell = w / 32
    for (let i = 0; i < 32; i++) {
      g.fillStyle = i % 2 ? "#2f4a37" : "#344f3b"; g.fillRect(i * cell, 0, cell, h)
      if (i >= 26) continue
      g.fillStyle = "#cfc6ad"; g.fillRect(i * cell + 3, 10, cell - 6, h - 20)
      g.fillStyle = "#1c1c1c"; g.font = "bold 34px Helvetica, Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"
      g.fillText(String.fromCharCode(65 + i), i * cell + cell / 2, h / 2 + 2)
    }
    grain(g, w, h, 9, 1)
  }),
  wood: () => canvas(1024, 1024, (g, w, h) => {
    // Walnut-look plastic laminate, grain along u (desk length), with rings and wear where hands rest.
    g.fillStyle = "#3b2a1d"; g.fillRect(0, 0, w, h)
    const r = rng(21)
    for (let i = 0; i < 520; i++) {
      const y0 = r() * h, amp = 2 + r() * 10, f = 0.002 + r() * 0.006, ph = r() * 7
      g.strokeStyle = r() < 0.5 ? `rgba(18,10,5,${0.15 + r() * 0.3})` : `rgba(105,72,44,${0.08 + r() * 0.18})`
      g.lineWidth = 0.6 + r() * 2.4
      g.beginPath()
      for (let x = 0; x <= w; x += 16) g.lineTo(x, y0 + Math.sin(x * f + ph) * amp + Math.sin(x * f * 3.1 + ph) * amp * 0.3)
      g.stroke()
    }
    grain(g, w, h, 22, 2)
    ring(g, w * 0.22, h * 0.4, 38, 0.3)
    ring(g, w * 0.26, h * 0.43, 38, 0.18)
    for (let i = 0; i < 70; i++) {
      g.strokeStyle = `rgba(160,130,95,${0.05 + r() * 0.1})`; g.lineWidth = 0.7
      const x = r() * w, y = r() * h, a = r() * 0.5 - 0.25, l = 20 + r() * 120
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke()
    }
  }, true),
  cloth: () => canvas(256, 256, (g, w, h) => {
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h)
    for (let y = 0; y < h; y += 2) { g.fillStyle = `rgba(0,0,0,${y % 4 ? 0.02 : 0.035})`; g.fillRect(0, y, w, 1) }
    for (let x = 0; x < w; x += 2) { g.fillStyle = "rgba(0,0,0,0.02)"; g.fillRect(x, 0, 1, h) }
    grain(g, w, h, 33, 2.5)
    const hem = g.createLinearGradient(0, h * 0.7, 0, h)
    hem.addColorStop(0, "rgba(40,30,15,0)"); hem.addColorStop(1, "rgba(40,30,15,0.35)")
    g.fillStyle = hem; g.fillRect(0, 0, w, h)
  }, true),
}

const cache = new Map<string, Material>()
function once<M extends Material>(key: string, make: () => M, metreUV = false): M {
  let m = cache.get(key) as M | undefined
  if (!m) {
    m = make()
    m.userData.shared = true
    m.userData.metreUV = metreUV
    if (!m.name) m.name = `interactive:${key}`
    cache.set(key, m)
  }
  return m
}

function mapped(key: keyof typeof textures, color: number, roughness: number, metalness = 0, vertexColors = false) {
  const m = new MeshStandardMaterial({ color, roughness, metalness, vertexColors })
  if (BROWSER) m.map = textures[key]()
  return m
}

const lin = (r: number, g: number, b: number) => [r, g, b] as const
const toHex = ([r, g, b]: readonly [number, number, number]) => {
  const s = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055))
  return (s(r) << 16) | (s(g) << 8) | s(b)
}

const RECIPES: Record<Finish, () => Material> = {
  steel: () => weatheredSteel({ color: 0x575d55, wear: 0.5, grime: 0.6, rust: 0.25, streaks: 0.35 }),
  inside: () => weatheredSteel({ color: 0x353933, wear: 0.25, grime: 0.9, rust: 0.45, streaks: 0.15 }),
  locker: () => weatheredSteel({ color: 0x666c64, wear: 0.7, grime: 0.65, rust: 0.55, streaks: 0.7 }),
  lockerInside: () => weatheredSteel({ color: 0x41463f, wear: 0.35, grime: 0.85, rust: 0.5, streaks: 0.35 }),
  safe: () => weatheredSteel({ color: 0x2a302c, wear: 0.4, grime: 0.5, rust: 0.18, streaks: 0.25 }),
  safeInside: () => weatheredSteel({ color: 0x24221d, wear: 0.15, grime: 0.7, rust: 0.2, streaks: 0.1 }),
  enamel: () => weatheredSteel({ color: 0x62665e, wear: 0.4, grime: 0.55, rust: 0.3, streaks: 0.4 }),
  board: () => weatheredSteel({ color: 0x2e302b, wear: 0.1, grime: 0.6, rust: 0.1, streaks: 0.1 }),
  chrome: () => materialFor("flat", { color: toHex(lin(0.45, 0.45, 0.43)), color2: toHex(lin(0.3, 0.28, 0.25)), roughness: 0.22, roughness2: 0.45, metalness: 1, metalness2: 0.9, noise: { scale: 3, channel: 3, lo: 0.55, hi: 1, smooth: true }, smudge: { amount: 0.3, size: 0.35 }, name: "interactive:chrome" }),
  brass: () => materialFor("flat", { color: toHex(lin(0.22, 0.155, 0.07)), color2: toHex(lin(0.09, 0.07, 0.04)), roughness: 0.3, roughness2: 0.6, metalness: 1, metalness2: 0.8, noise: { scale: 30, channel: 2, lo: 0.4, hi: 0.95, smooth: true }, smudge: { amount: 0.25, size: 0.2 }, name: "interactive:brass" }),
  nickel: () => materialFor("flat", { color: toHex(lin(0.42, 0.42, 0.4)), color2: toHex(lin(0.18, 0.17, 0.15)), roughness: 0.3, roughness2: 0.55, metalness: 1, noise: { scale: 30, channel: 3, lo: 0.4, hi: 0.95 }, name: "interactive:nickel" }),
  rubber: () => library("rubber"),
  slot: () => materialFor("flat", { color: 0x050505, roughness: 0.9, name: "interactive:slot" }),
  putty: () => materialFor("flat", { color: 0x8a826c, color2: 0x7a7260, roughness: 0.55, roughness2: 0.7, noise: { scale: 2, channel: 2, lo: 0.2, hi: 1, smooth: true }, smudge: { amount: 0.2, size: 0.4 }, name: "interactive:putty" }),
  keycap: () => materialFor("flat", { color: 0x958d78, color2: 0x7d7562, roughness: 0.5, roughness2: 0.7, noise: { scale: 40, channel: 3, lo: 0.5, hi: 1 }, name: "interactive:keycap" }),
  keycapDark: () => materialFor("flat", { color: 0x4a3f33, color2: 0x2e2820, roughness: 0.5, roughness2: 0.7, noise: { scale: 40, channel: 3, lo: 0.5, hi: 1 }, name: "interactive:keycap-dark" }),
  wood: () => mapped("wood", BROWSER ? 0xffffff : 0x3b2a1d, 0.55),
  paper: () => mapped("label", BROWSER ? 0xffffff : 0xd9d2bd, 0.9),
  manila: () => mapped("manila", BROWSER ? 0xffffff : 0x958670, 0.88, 0, true),
  pressboard: () => materialFor("flat", { color: 0x2c4533, color2: 0x1d2e22, roughness: 0.8, roughness2: 0.92, noise: { scale: 14, channel: 3, lo: 0.2, hi: 1 }, name: "interactive:pressboard" }),
  tabs: () => mapped("pressboard", BROWSER ? 0xffffff : 0x2f4a37, 0.8),
  pencil: () => materialFor("flat", { color: 0xa47b16, color2: 0x6e520f, roughness: 0.45, roughness2: 0.6, noise: { scale: 30, channel: 3, lo: 0.5, hi: 1 }, name: "interactive:pencil" }),
  eraser: () => materialFor("flat", { color: 0x8a4b47, roughness: 0.9, name: "interactive:eraser" }),
  led: () => materialFor("flat", { color: 0x020a03, emissive: 0x30ff60, intensity: 4, name: "interactive:led" }),
  hardboard: () => materialFor("flat", { color: 0x3a2617, color2: 0x24170e, roughness: 0.75, roughness2: 0.9, noise: { scale: 12, channel: 3, lo: 0.3, hi: 1 }, name: "interactive:hardboard" }),
  coat: () => mapped("cloth", 0x7a776d, 0.95, 0, true),
  jacket: () => mapped("cloth", 0x2a3240, 0.92, 0, true),
  leather: () => materialFor("flat", { color: 0x21160f, color2: 0x0d0907, roughness: 0.55, roughness2: 0.85, noise: { scale: 18, channel: 2, lo: 0.3, hi: 0.9 }, name: "interactive:leather" }),
  redFob: () => materialFor("flat", { color: 0x7a1510, color2: 0x3a0806, roughness: 0.4, roughness2: 0.7, noise: { scale: 50, channel: 3 }, name: "interactive:red-fob" }),
}
const METRE_UV = new Set<Finish>(["steel", "inside", "locker", "lockerInside", "safe", "safeInside", "enamel", "board", "wood", "chrome", "brass", "nickel", "putty", "hardboard", "leather", "pressboard"])

export function finish(name: Finish): Material {
  return once(name, () => {
    const m = RECIPES[name]()
    // Library materials are shared with the building; never rename them.
    if (!m.name || m.name.startsWith("weathered_")) m.name = `interactive:${name}`
    return m
  }, METRE_UV.has(name))
}

/** Printed card, stamped aluminium plate or embossed tape, cached by text. Front face UV 0..1. */
export function labelMaterial(text: string, style: "card" | "plate" | "tape" = "card"): Material {
  return once(`label:${style}:${text}`, () => {
    const colors = { card: ["#cbbf9c", "#26231d"], plate: ["#8d8f8a", "#141513"], tape: ["#141414", "#d8d8d2"] }[style]
    const m = new MeshStandardMaterial({ color: BROWSER ? 0xffffff : colors[0], roughness: style === "plate" ? 0.45 : 0.85, metalness: style === "plate" ? 0.6 : 0 })
    if (BROWSER) m.map = canvas(512, 128, (g, w, h) => {
      g.fillStyle = colors[0]; g.fillRect(0, 0, w, h)
      if (style === "plate") for (let x = 0; x < w; x += 2) { g.fillStyle = `rgba(255,255,255,${0.04 + 0.04 * Math.sin(x * 1.7)})`; g.fillRect(x, 0, 1, h) }
      if (style === "card") { g.strokeStyle = "rgba(140,40,30,0.35)"; g.lineWidth = 2; g.beginPath(); g.moveTo(10, h - 26); g.lineTo(w - 10, h - 26); g.stroke() }
      g.textAlign = "center"; g.textBaseline = "middle"
      g.font = style === "card" ? "bold 64px 'Courier New', monospace" : "bold 72px Helvetica, Arial, sans-serif"
      if (style === "plate") { g.fillStyle = "rgba(255,255,255,0.35)"; g.fillText(text, w / 2 + 2, h / 2 + 3, w - 40) }
      g.fillStyle = colors[1]; g.fillText(text, w / 2, h / 2, w - 40)
      grain(g, w, h, hashString(text), style === "tape" ? 0.4 : 1.4)
      g.strokeStyle = "rgba(0,0,0,0.35)"; g.lineWidth = 6; g.strokeRect(0, 0, w, h)
    })
    m.name = `interactive:label:${style}:${text}`
    return m
  })
}

// ------------------------------------------------------------------------------------------------ geometry

const ATTRS = ["position", "normal", "uv", "color"] as const

/** Box-projected metre UVs (prop-local, v = height above the floor; tops/bottoms get v ≥ 2) and vertex AO. */
function prepare(mesh: Mesh, toRoot: Matrix4, seed: number) {
  const g = mesh.geometry
  const p = g.getAttribute("position"), n = g.getAttribute("normal")
  const count = p.count
  const material = mesh.material as Material
  const ao = mesh.userData.ao as AO | undefined
  if (!g.getAttribute("uv")) g.setAttribute("uv", new Float32BufferAttribute(new Float32Array(count * 2), 2))
  const uv = g.getAttribute("uv")
  const colors = new Float32Array(count * 3)
  const rootNormal = new Matrix3().getNormalMatrix(toRoot), local = new Matrix3().getNormalMatrix(mesh.matrix)
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), d = new Vector3()
  const du = (seed % 997) * 0.37
  for (let i = 0; i < count; i++) {
    if (material.userData.metreUV) {
      a.fromBufferAttribute(p, i).applyMatrix4(toRoot)
      b.fromBufferAttribute(n, i).applyMatrix3(rootNormal).normalize()
      const ax = Math.abs(b.x), ay = Math.abs(b.y), az = Math.abs(b.z)
      if (ay >= ax && ay >= az) uv.setXY(i, a.x + du, a.z + 2.3)
      else if (ax >= az) uv.setXY(i, a.z * Math.sign(b.x) + du, a.y)
      else uv.setXY(i, a.x * Math.sign(b.z) + du, a.y)
    }
    let k = 1
    if (ao) {
      c.fromBufferAttribute(p, i).applyMatrix4(mesh.matrix)
      d.fromBufferAttribute(n, i).applyMatrix3(local).normalize()
      k = Math.max(0.15, Math.min(1, ao(c, d)))
    }
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = k
  }
  uv.needsUpdate = true
  g.setAttribute("color", new Float32BufferAttribute(colors, 3))
  for (const name of Object.keys(g.attributes)) if (!(ATTRS as readonly string[]).includes(name)) g.deleteAttribute(name)
  g.clearGroups()
}

/**
 * Finishes an assembled prop: metre UVs and baked AO on every mesh, then one merged mesh per (anchor, material), where
 * an anchor is the root, a moving part, a socket, a revealed group or a kept mesh; static groups in between are baked
 * into the geometry. Collision sheets stay as invisible proxies (their bounds still drive the colliders); interaction
 * handles, animated meshes (`userData.keep`) and prebuilt batches (`userData.raw`) are left alone.
 */
export function finishProp(prop: InteractiveProp) {
  const root = prop.root
  root.updateWorldMatrix(true, true)
  const inverse = new Matrix4().copy(root.matrixWorld).invert()
  const keep = new Set<Object3D>(prop.targets.map(t => t.node))
  const anchors = new Set<Object3D>([root, ...[...prop.parts.values()].map(p => p.pivot), ...[...prop.sockets.values()].map(s => s.node), ...prop.reveals.map(r => r.node)])
  root.traverse(node => { if (node instanceof Mesh && (keep.has(node) || node.userData.keep)) anchors.add(node) })
  const solids = new Set<Object3D>(prop.solids)
  const seed = hashString(prop.id)
  const groups = new Map<Object3D, Map<Material, Mesh[]>>()
  const toRoot = new Matrix4()
  root.traverse(node => {
    if (!(node instanceof Mesh) || node.userData.raw || Array.isArray(node.material)) return
    prepare(node, toRoot.multiplyMatrices(inverse, node.matrixWorld), seed)
    if (anchors.has(node)) return
    let anchor = node.parent!
    while (!anchors.has(anchor)) anchor = anchor.parent!
    let byMaterial = groups.get(anchor)
    if (!byMaterial) groups.set(anchor, byMaterial = new Map())
    const list = byMaterial.get(node.material) ?? []
    list.push(node)
    byMaterial.set(node.material, list)
  })
  const local = new Matrix4()
  const emptied = new Set<Object3D>()
  for (const [anchor, byMaterial] of groups) {
    const toAnchor = new Matrix4().copy(anchor.matrixWorld).invert()
    for (const [material, meshes] of byMaterial) {
      if (meshes.length < 2 && meshes[0].parent === anchor && !solids.has(meshes[0])) continue
      const parts: BufferGeometry[] = meshes.map(m => (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(local.multiplyMatrices(toAnchor, m.matrixWorld)))
      const merged = mergeGeometries(parts)
      parts.forEach(g => g.dispose())
      if (!merged) throw new Error(`Could not merge ${prop.id} ${material.name}`)
      const mesh = new Mesh(merged, material)
      mesh.name = `${prop.id}:${material.name}`
      mesh.castShadow = meshes.some(m => m.castShadow)
      mesh.receiveShadow = true
      anchor.add(mesh)
      for (const m of meshes) {
        if (solids.has(m)) { m.visible = false; m.castShadow = false }
        else { emptied.add(m.parent!); m.removeFromParent(); m.geometry.dispose() }
      }
    }
  }
  // Drop the static groups the merge left empty (not ones the caller still means to fill, like a screen mount).
  for (const node of emptied) { let n: Object3D | null = node; while (n && !anchors.has(n) && !(n instanceof Mesh) && !n.children.length) { const parent: Object3D | null = n.parent; n.removeFromParent(); n = parent } }
}

/** Darkens toward the back and the corners of an open-fronted box of `w × h × d` whose front is at +z. */
export function cavityAO(w: number, h: number, d: number, floor = 0, strength = 0.6): AO {
  return (p, n) => {
    const inside = Math.abs(p.x) < w / 2 + 0.002 && p.z < d / 2 - 0.004 && p.y > floor - 0.002 && p.y < floor + h + 0.002
    const facingIn = n.z > 0.5 || Math.abs(n.x) > 0.5 && Math.sign(n.x) === -Math.sign(p.x) || n.y > 0.5 && p.y < floor + h / 2 || n.y < -0.5 && p.y > floor + h / 2
    if (!inside || !facingIn) return 1
    const depth = Math.min(1, Math.max(0, (d / 2 - p.z) / d))
    const edge = Math.min(Math.abs(p.y - floor), Math.abs(floor + h - p.y), w / 2 - Math.abs(p.x))
    const corner = 1 - Math.exp(-edge / 0.06)
    return 1 - strength * (0.35 + 0.65 * depth) * (1 - 0.5 * corner)
  }
}
