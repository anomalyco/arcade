import * as THREE from "three/webgpu"
import { float, luminance, mix, texture, uniform } from "three/tsl"
import { SHEET_MM } from "./pages"

// The clipboard itself: a 1/8" tempered hardboard (masonite) board with rounded corners, a low-profile steel clip
// (riveted base, spring roll, pressure plate, wire hanging loop), a short stack of sheets under it, the top sheet
// carrying the current page and one sheet that animates when a page is flipped up over the clip.
// Local frame: board in the XY plane, facing +Z, origin at the board centre; metres.

export const PAGE_W = SHEET_MM[0] / 1000
export const PAGE_H = SHEET_MM[1] / 1000
export const BOARD = { w: 0.305, h: 0.246, t: 0.0032, r: 0.009 }
/** Page top edge (under the clip), local y. */
const PAGE_TOP = BOARD.h / 2 - 0.017
const FRONT = BOARD.t / 2
const NX = 10
const NY = 12

function masoniteTexture() {
  const c = document.createElement("canvas")
  c.width = c.height = 256
  const g = c.getContext("2d")!
  g.fillStyle = "#5e432b"
  g.fillRect(0, 0, 256, 256)
  // Pressed-fibre mottling and a faint screen pattern.
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * 256
    const y = Math.random() * 256
    const l = Math.random()
    g.fillStyle = l < 0.5 ? `rgba(40,26,14,${0.05 + Math.random() * 0.08})` : `rgba(130,98,66,${0.04 + Math.random() * 0.07})`
    g.fillRect(x, y, 1 + Math.random() * 6, 1 + Math.random() * 1.5)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(3, 3)
  return t
}

function blankPaper() {
  const c = document.createElement("canvas")
  c.width = 64
  c.height = 50
  const g = c.getContext("2d")!
  g.fillStyle = "#f0eee6"
  g.fillRect(0, 0, 64, 50)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.flipY = false
  return t
}

function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  return s
}

/** A sheet as a grid (u right, v down from the top edge, v = 0 at the top: the page images are not flipped). */
function sheetGeometry() {
  const g = new THREE.PlaneGeometry(PAGE_W, PAGE_H, NX, NY)
  const uv = g.getAttribute("uv") as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
  return g
}

const makeAmbient = () => uniform(0)
type Ambient = ReturnType<typeof makeAmbient>

function paperMaterial(map: THREE.Texture, ambient: Ambient) {
  const m = new THREE.MeshStandardNodeMaterial()
  const tex = texture(map)
  m.colorNode = tex
  // Toner and ballpoint sit a little glossier than the matte bond paper.
  m.roughnessNode = mix(float(0.62), float(0.9), luminance(tex.rgb))
  m.metalness = 0
  // Faint fill so the sheet never goes fully black (eyes adapted to the dark; see index.ts).
  m.emissiveNode = tex.rgb.mul(ambient)
  m.side = THREE.FrontSide
  return { m, tex }
}

export class Clipboard {
  readonly root = new THREE.Group()
  /** The sheet showing the current page. */
  private top: ReturnType<typeof paperMaterial>
  private flipFront: ReturnType<typeof paperMaterial>
  private flipGeo = sheetGeometry()
  private flipMeshes: THREE.Mesh[]
  private base = new Float32Array(0)
  readonly ambient: Ambient = makeAmbient()
  readonly blank = blankPaper()

  constructor() {
    this.root.name = "map:clipboard"
    const board = new THREE.ExtrudeGeometry(roundedRect(BOARD.w, BOARD.h, BOARD.r), { depth: BOARD.t, bevelEnabled: true, bevelThickness: 0.0004, bevelSize: 0.0004, bevelSegments: 1, curveSegments: 6 })
    board.translate(0, 0, -BOARD.t / 2)
    const boardMat = new THREE.MeshStandardNodeMaterial({ map: masoniteTexture(), roughness: 0.48, metalness: 0 })
    boardMat.emissiveNode = (texture(boardMat.map!) as ReturnType<typeof texture>).rgb.mul(this.ambient)
    const boardMesh = new THREE.Mesh(board, boardMat)
    this.root.add(boardMesh)

    // Clip.
    const steel = new THREE.MeshStandardNodeMaterial({ color: 0xb4b7ba, roughness: 0.3, metalness: 0.75 })
    steel.emissiveNode = float(0.04).mul(this.ambient)
    const clip = new THREE.Group()
    const y0 = BOARD.h / 2
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.014, 0.0011), steel)
    plate.position.set(0, y0 - 0.009, FRONT + 0.0006)
    clip.add(plate)
    for (const sx of [-0.035, 0.035]) {
      const rivet = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 0.0012, 12), steel)
      rivet.rotation.x = Math.PI / 2
      rivet.position.set(sx, y0 - 0.006, FRONT + 0.0016)
      clip.add(rivet)
    }
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, 0.112, 18), steel)
    roll.rotation.z = Math.PI / 2
    roll.position.set(0, y0 - 0.0135, FRONT + 0.0042)
    clip.add(roll)
    // Pressure plate: from the roll down onto the paper, curling up at its edge.
    const pp = new THREE.Mesh(new THREE.BoxGeometry(0.118, 0.011, 0.0009), steel)
    pp.position.set(0, y0 - 0.0195, FRONT + 0.0032)
    pp.rotation.x = -0.2
    clip.add(pp)
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.118, 0.004, 0.0009), steel)
    lip.position.set(0, y0 - 0.0255, FRONT + 0.0026)
    lip.rotation.x = 0.7
    clip.add(lip)
    // Wire hanging loop (the lever) lying back over the top.
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.0022, 8, 28, Math.PI), steel)
    loop.position.set(0, y0 - 0.0135, FRONT + 0.0045)
    loop.rotation.x = -1.25
    clip.add(loop)
    this.root.add(clip)

    // Sheets under the top one: plain backs of the rest of the set, edges just showing.
    const under = new THREE.MeshStandardNodeMaterial({ color: 0xe6e3d9, roughness: 0.9 })
    under.emissiveNode = float(0.82).mul(this.ambient)
    for (let k = 0; k < 3; k++) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(PAGE_W, PAGE_H), under)
      s.position.set((k - 1) * 0.0007, PAGE_TOP - PAGE_H / 2 - k * 0.0004, FRONT + 0.0003 + k * 0.00018)
      s.rotation.z = (k - 1) * 0.0025
      this.root.add(s)
    }
    this.top = paperMaterial(this.blank, this.ambient)
    const topGeo = sheetGeometry()
    // A slight bow across the sheet.
    const p = topGeo.getAttribute("position") as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / (PAGE_W / 2)
      const y = (p.getY(i) + PAGE_H / 2) / PAGE_H
      p.setZ(i, (1 - x * x) * 0.0012 * (1 - y) + 0.0004 * y * y)
    }
    topGeo.computeVertexNormals()
    const topMesh = new THREE.Mesh(topGeo, this.top.m)
    topMesh.position.set(0, PAGE_TOP - PAGE_H / 2, FRONT + 0.0011)
    this.root.add(topMesh)

    // The flipping sheet: front (page) and back (plain) share one animated grid.
    this.flipFront = paperMaterial(this.blank, this.ambient)
    const back = new THREE.MeshStandardNodeMaterial({ color: 0xe9e6dd, roughness: 0.9, side: THREE.BackSide })
    back.emissiveNode = float(0.84).mul(this.ambient)
    this.base = new Float32Array((this.flipGeo.getAttribute("position") as THREE.BufferAttribute).array)
    this.flipMeshes = [new THREE.Mesh(this.flipGeo, this.flipFront.m), new THREE.Mesh(this.flipGeo, back)]
    for (const m of this.flipMeshes) {
      m.visible = false
      m.frustumCulled = false
      this.root.add(m)
    }
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = false
        o.receiveShadow = true
        o.renderOrder = 10
      }
    })
  }

  setTop(t: THREE.Texture | null) {
    this.top.tex.value = t ?? this.blank
  }

  /**
   * Shows the flipping sheet with `t` at progress `a` (0 lying on the board … 1 thrown up over the clip), or hides
   * it (`t` undefined). The sheet bends about the clip line, its free end lagging behind mid-flip.
   */
  setFlip(t: THREE.Texture | null | undefined, a = 0) {
    const on = t !== undefined
    for (const m of this.flipMeshes) m.visible = on
    if (!on) return
    this.flipFront.tex.value = t ?? this.blank
    const theta = a * Math.PI * 1.04
    const lag = 0.42 * Math.sin(Math.PI * a)
    const pos = this.flipGeo.getAttribute("position") as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    const z0 = FRONT + 0.0016 + 0.0016 * Math.sin(Math.PI * a)
    // Integrate the sheet's centre line from the clip down (row 0 is the top edge).
    let y = PAGE_TOP
    let z = z0
    const rows: [number, number][] = [[y, z]]
    const ds = PAGE_H / NY
    for (let j = 1; j <= NY; j++) {
      const s = (j - 0.5) / NY
      const phi = theta * (1 - lag * s ** 1.4)
      y -= Math.cos(phi) * ds
      z += Math.sin(phi) * ds
      rows.push([y, z])
    }
    for (let j = 0; j <= NY; j++) {
      const [ry, rz] = rows[j]!
      for (let i = 0; i <= NX; i++) {
        const k = (j * (NX + 1) + i) * 3
        const x = this.base[k]!
        arr[k] = x
        // A touch of cupping across the sheet while it's in the air.
        const cup = (1 - (x / (PAGE_W / 2)) ** 2) * 0.006 * Math.sin(Math.PI * a)
        arr[k + 1] = ry
        arr[k + 2] = rz + cup
      }
    }
    pos.needsUpdate = true
    this.flipGeo.computeVertexNormals()
    this.flipGeo.computeBoundingSphere()
  }
}
