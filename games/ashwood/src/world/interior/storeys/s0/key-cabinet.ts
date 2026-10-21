import * as THREE from "three/webgpu"
import { type Builder, T, paint } from "../../api"

// The Facilities key cabinet in 0-30: a 1984 wall-mounted steel key cabinet, 40 × 50 × 10 cm, grey enamel, a hinged
// door with a small cam lock and a "KEYS" plate. Inside, a perforated hook board with five rows of six hooks and a
// printed number tag over each; most hooks hold a ring of keys with a fob, some are empty. TRUCK 2 (hook 6, top
// right) has a red fob and its own tag; taking it (search-spots.ts `keyCabinet`, src/game/search) leaves the hook
// bare. The door swings open on its left hinge.

const W = 0.4
const H = 0.5
const D = 0.1
const WALL = 0.008
/** Hooks: columns × rows, spacing, and the board's top-left hook (cabinet frame, x right as seen from the front). */
const COLS = 6
const ROWS = 5
const DX = 0.058
const DY = 0.088
const X0 = -((COLS - 1) * DX) / 2
const Y0 = 0.17
/** The one hook that matters in each box (its own object, taken by the search system). */
export type SpecialHook = { col: number; row: number; label: string; fob: number; keys: number }
const TRUCK: SpecialHook = { col: 5, row: 0, label: "TRUCK 2", fob: 0xa3201a, keys: 2 }

const ENAMEL = paint(0x7d817a, 0.62, 0.25)
const INSIDE = paint(0x9a9d94, 0.7, 0.2)
const STEEL = paint(0xa7aaa6, 0.35, 0.85)
const BRASS = paint(0x8a6a2a, 0.35, 0.85)
const NICKEL = paint(0x9fa2a0, 0.3, 0.9)
const FOBS = [0x2f4a7a, 0x3f5a35, 0xb0a27a, 0x6b4a2a, 0x7a7d78, 0xc8bfa8]

function plate(text: string[], w: number, h: number, bg: string, fg: string, px = 1600) {
  const c = document.createElement("canvas")
  c.width = Math.round(w * px)
  c.height = Math.round(h * px)
  const g = c.getContext("2d")!
  g.fillStyle = bg
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = fg
  g.textAlign = "center"
  g.textBaseline = "middle"
  const lh = c.height / text.length
  text.forEach((t, i) => {
    g.font = `bold ${Math.round(lh * 0.7)}px Helvetica, Arial, sans-serif`
    g.fillText(t, c.width / 2, lh * (i + 0.5))
  })
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.75, metalness: 0 })
}

/** The hook board's print: a tag strip with the hook number over every hook (one texture for the whole board). */
function boardMaterial(special: SpecialHook, footer: string) {
  const px = 2000
  const c = document.createElement("canvas")
  c.width = Math.round((W - 2 * WALL) * px)
  c.height = Math.round((H - 2 * WALL) * px)
  const g = c.getContext("2d")!
  g.fillStyle = "#43453f"
  g.fillRect(0, 0, c.width, c.height)
  // Pegboard perforations.
  g.fillStyle = "rgba(30,32,30,0.55)"
  for (let y = 10; y < c.height; y += 24) for (let x = 10; x < c.width; x += 24) g.fillRect(x, y, 4, 4)
  const cx = (x: number) => (x + (W - 2 * WALL) / 2) * px
  const cy = (y: number) => ((H - 2 * WALL) / 2 - y) * px
  for (let r = 0; r < ROWS; r++)
    for (let k = 0; k < COLS; k++) {
      const n = r * COLS + k + 1
      const x = cx(X0 + k * DX)
      const y = cy(Y0 - r * DY) - 0.02 * px
      const sp = r === special.row && k === special.col
      g.fillStyle = sp ? "#b3ac96" : "#8e8a7b"
      g.fillRect(x - 0.022 * px, y - 0.009 * px, 0.044 * px, 0.018 * px)
      g.fillStyle = sp ? "#a3241c" : "#1a1a1a"
      g.font = `bold ${Math.round((sp ? 0.0095 : 0.012) * px)}px Helvetica, Arial, sans-serif`
      g.textAlign = "center"
      g.textBaseline = "middle"
      g.fillText(sp ? special.label : String(n), x, y + 1)
    }
  g.fillStyle = "#1a1a1a"
  g.font = `bold ${Math.round(0.012 * px)}px Helvetica, Arial, sans-serif`
  g.textAlign = "left"
  g.fillText(footer, 0.012 * px, c.height - 0.012 * px)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  const m = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.92, metalness: 0 })
  m.name = "interior_key_board"
  return m
}

/** A ring of `n` keys with a fob, hanging from a hook at `p` (cabinet frame), into `out` (or the static batch). */
function keyRing(b: Builder, m: THREE.Matrix4, x: number, y: number, z: number, fob: number, n: number, seed: number, out?: THREE.Group) {
  const parts: [THREE.BufferGeometry, THREE.MeshStandardNodeMaterial | ReturnType<typeof paint>][] = []
  const ring = new THREE.TorusGeometry(0.011, 0.0012, 5, 14).translate(0, -0.012, 0)
  parts.push([ring, NICKEL])
  for (let k = 0; k < n; k++) {
    const a = (k - (n - 1) / 2) * 0.35 + Math.sin(seed + k) * 0.08
    const key = new THREE.BoxGeometry(0.0016, 0.042, 0.011).translate(0, -0.021, 0).rotateZ(a).translate(Math.sin(a) * 0.01, -0.022, 0.001 * k)
    parts.push([key, k % 2 ? NICKEL : BRASS])
  }
  const fobG = new THREE.BoxGeometry(0.004, 0.034, 0.022).translate(0, -0.042, -0.004).rotateZ(-0.12 + Math.sin(seed) * 0.1)
  parts.push([fobG, paint(fob, 0.5, 0)])
  const at = new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().makeTranslation(x, y, z)).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
  for (const [g, mat] of parts) {
    g.applyMatrix4(at)
    if (out) {
      const mesh = new THREE.Mesh(g, mat === NICKEL ? nickelMat() : mat === BRASS ? brassMat() : new THREE.MeshStandardNodeMaterial({ color: fob, roughness: 0.45 }))
      mesh.position.y += b.oy
      mesh.castShadow = true
      out.add(mesh)
    } else b.add(mat as ReturnType<typeof paint>, g, { cast: false })
  }
}
let nickel: THREE.MeshStandardNodeMaterial | null = null
let brass: THREE.MeshStandardNodeMaterial | null = null
const nickelMat = () => (nickel ??= new THREE.MeshStandardNodeMaterial({ color: 0x9fa2a0, roughness: 0.3, metalness: 0.9 }))
const brassMat = () => (brass ??= new THREE.MeshStandardNodeMaterial({ color: 0x8a6a2a, roughness: 0.35, metalness: 0.85 }))

export type KeyBoxOpts = {
  /** Which way the room is from the wall (−1: room on the −x side). */
  side?: -1 | 1
  special?: SpecialHook
  footer?: string
  /** Door plate lines and the paper tag (none: no tag). */
  card?: string[]
  tag?: string[]
  open?: boolean
  seed?: number
}
export type KeyBox = { door: THREE.Group; keys: THREE.Group; at: [number, number, number]; open(): void }

/** Builds the cabinet on the wall face at `wallX` (an x-facing wall), centred at (y, z). */
export function keyCabinetOn(b: Builder, wallX: number, y: number, z: number, o: KeyBoxOpts = {}): KeyBox {
  const side = o.side ?? -1
  const special = o.special ?? TRUCK
  // Cabinet frame: origin at the box centre, front at local −z facing the room; local +x is the viewer's left.
  const m = T(wallX + side * (D / 2 + 0.004), y, z, side < 0 ? Math.PI / 2 : -Math.PI / 2)
  // Box: back, top, bottom, sides (open front), a lip round the opening.
  b.boxM(ENAMEL, m, W, H, WALL, 0, 0, D / 2 - WALL / 2)
  b.boxM(ENAMEL, m, W, WALL, D, 0, H / 2 - WALL / 2, 0)
  b.boxM(ENAMEL, m, W, WALL, D, 0, -H / 2 + WALL / 2, 0)
  for (const s of [-1, 1]) b.boxM(ENAMEL, m, WALL, H, D, s * (W / 2 - WALL / 2), 0, 0)
  // Hook board on the back, its printed tags.
  const board = new THREE.Mesh(new THREE.PlaneGeometry(W - 2 * WALL, H - 2 * WALL), boardMaterial(special, o.footer ?? "FACILITIES 0-30 · RETURN ALL KEYS · SIGN THE BOOK"))
  const bm = m.clone().multiply(T(0, 0, D / 2 - WALL - 0.002, Math.PI))
  bm.decompose(board.position, board.quaternion, board.scale)
  board.position.y += b.oy
  board.receiveShadow = true
  b.small.add(board)
  // Hooks (a short bent rod each) and the key rings on them; TRUCK 2's ring is its own group.
  const zb = D / 2 - WALL - 0.003
  let seed = o.seed ?? 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const truckKeys = new THREE.Group()
  truckKeys.name = `key-box:${special.label}`
  for (let r = 0; r < ROWS; r++)
    for (let k = 0; k < COLS; k++) {
      // (Frame +x is the viewer's LEFT: hook k sits at −(X0 + k·DX) so numbers run left to right as seen.)
      const x = -(X0 + k * DX)
      const hy = Y0 - r * DY
      const p0 = new THREE.Vector3(x, hy, zb).applyMatrix4(m)
      const p1 = new THREE.Vector3(x, hy, zb - 0.026).applyMatrix4(m)
      const p2 = new THREE.Vector3(x, hy + 0.006, zb - 0.03).applyMatrix4(m)
      b.rod(STEEL, [p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], 0.0018, 5)
      b.rod(STEEL, [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], 0.0018, 5)
      if (r === special.row && k === special.col) keyRing(b, m, x, hy, zb - 0.022, special.fob, special.keys, 3, truckKeys)
      else if (rnd() < 0.7) keyRing(b, m, x, hy, zb - 0.022, FOBS[Math.floor(rnd() * FOBS.length)]!, 1 + Math.floor(rnd() * 3), r * 7 + k)
    }
  b.small.add(truckKeys)

  // The door: hinged on the right edge as seen from the front, its own object; a cam lock and the KEYS plate.
  const doorMat = new THREE.MeshStandardNodeMaterial({ color: 0x7d817a, roughness: 0.62, metalness: 0.25 })
  doorMat.name = "interior_key_cabinet_door"
  const pivot = new THREE.Group()
  const hinge = m.clone().multiply(T(-W / 2, 0, -D / 2 - 0.006))
  hinge.decompose(pivot.position, pivot.quaternion, pivot.scale)
  pivot.position.y += b.oy
  const door = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.012), doorMat)
  door.position.x = W / 2
  door.castShadow = true
  door.receiveShadow = true
  pivot.add(door)
  // Rolled edge, lock barrel with a slot, the plate (on the door's front, local −z).
  const lock = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.012, 16).rotateX(Math.PI / 2), nickelMat())
  lock.position.set(W - 0.035, 0, -0.01)
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.0025, 0.012, 0.002), new THREE.MeshStandardNodeMaterial({ color: 0x111111 }))
  slot.position.set(W - 0.035, 0, -0.0165)
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.04), plate(["KEYS"], 0.12, 0.04, "#1d1f1e", "#e8e2cf"))
  label.position.set(W / 2, H / 2 - 0.06, -0.01)
  label.rotation.y = Math.PI
  door.add(lock, slot, label)
  if (o.card) {
    const card = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.035), plate(o.card, 0.1, 0.035, "#d9d2bd", "#1a1a1a"))
    card.position.set(W / 2, H / 2 - 0.105, -0.01)
    card.rotation.y = Math.PI
    door.add(card)
  }
  if (o.tag) {
    // A manila tag on a string from the lock: large enough to read at arm's length.
    const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.08), plate(o.tag, 0.17, 0.08, "#c4b48a", "#1a1a1a", 2000))
    tag.position.set(W - 0.11, -0.075, -0.0115)
    tag.rotation.set(0, Math.PI, 0.06)
    const str = new THREE.Mesh(new THREE.BoxGeometry(0.0015, 0.04, 0.0015), new THREE.MeshStandardNodeMaterial({ color: 0xd8d0b8 }))
    str.position.set(W - 0.045, -0.02, -0.013)
    str.rotation.z = -0.6
    door.add(tag, str)
  }
  for (const c of door.children) c.position.x -= W / 2
  b.small.add(pivot)
  const open = () => {
    if (pivot.userData.open) return
    pivot.userData.open = true
    pivot.rotateY(1.9)
  }
  if (o.open) open()
  const at = new THREE.Vector3(0, 0, -D / 2 - 0.06).applyMatrix4(m)
  b.collide(Math.min(wallX, wallX + side * (D + 0.01)), y - H / 2, z - W / 2, Math.max(wallX, wallX + side * (D + 0.01)), y + H / 2, z + W / 2)
  /** The special hook's position (world), for aiming at it. */
  const hk = new THREE.Vector3(-(X0 + special.col * DX), Y0 - special.row * DY - 0.03, D / 2 - 0.04).applyMatrix4(m)
  truckKeys.userData.at = [hk.x, hk.y + b.oy, hk.z]
  return { door: pivot, keys: truckKeys, at: [at.x, at.y + b.oy, at.z], open }
}
