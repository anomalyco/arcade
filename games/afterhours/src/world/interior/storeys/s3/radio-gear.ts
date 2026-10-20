import * as THREE from "three/webgpu"
import { type Builder, M, paint } from "../../api"
import { pt, sub } from "./equipment"

// 1984 rack-mount radio gear for the operator desk: a 19-inch panel in a sharp steel cabinet (2–3 mm bevels), rack
// ears with handles, a printed/engraved faceplate (maker, model, legends round every control, meter scales), real
// knobs (skirted, with a pointer line) and toggle switches. Front at local −Z, like the room's other gear.

export type RadioUnitOpts = {
  maker: string
  model: string
  /** Panel width and height (m), cabinet depth. */
  w?: number
  h?: number
  d?: number
  /** Analog meters across the top (labels), knobs along the bottom (labels). */
  meters?: string[]
  knobs?: string[]
  /** A tuning window (glowing frequency scale) instead of the first meter. */
  tuning?: boolean
  panel?: string
}

const PX = 1400
const CAB = paint(0x3c403e, 0.45, 0.35)
const EAR = paint(0x8f948f, 0.35, 0.8)
const KNOB = paint(0x141414, 0.4, 0.1)
const SKIRT = paint(0x9ba09b, 0.3, 0.85)

function faceplate(o: Required<RadioUnitOpts>, knobsAt: [number, string][], metersAt: [number, string][]) {
  const c = document.createElement("canvas")
  c.width = Math.round(o.w * PX)
  c.height = Math.round(o.h * PX)
  const g = c.getContext("2d")!
  g.scale(PX, PX)
  const W = o.w
  const H = o.h
  g.fillStyle = o.panel
  g.fillRect(0, 0, W, H)
  // Brushed grain and a darker frame.
  for (let y = 0; y < H; y += 0.0015) {
    g.fillStyle = `rgba(255,255,255,${0.012 + ((y * 9301) % 1) * 0.02})`
    g.fillRect(0, y, W, 0.0007)
  }
  g.strokeStyle = "rgba(0,0,0,0.5)"
  g.lineWidth = 0.002
  g.strokeRect(0.001, 0.001, W - 0.002, H - 0.002)
  const text = (s: string, x: number, y: number, size: number, color = "#1a1a1a", weight = 700, align: CanvasTextAlign = "center") => {
    g.font = `${weight} ${size}px Helvetica, Arial, sans-serif`
    g.textAlign = align
    g.textBaseline = "middle"
    g.fillStyle = color
    g.fillText(s, x, y)
  }
  // Canvas x runs to the viewer's right = local −u... the panel is drawn as seen from the front (local u = W/2 − x).
  text(o.maker, 0.035, 0.016, 0.011, "#1a1a1a", 900, "left")
  text(o.model, W - 0.035, 0.016, 0.01, "#1a1a1a", 700, "right")
  for (const [u, label] of metersAt) {
    const x = W / 2 + u
    g.fillStyle = "#151515"
    g.fillRect(x - 0.036, 0.03, 0.072, 0.048)
    g.fillStyle = "#e9dcb4"
    g.fillRect(x - 0.032, 0.033, 0.064, 0.04)
    g.strokeStyle = "#1a1a1a"
    g.lineWidth = 0.0008
    g.beginPath()
    g.arc(x, 0.085, 0.04, -Math.PI * 0.8, -Math.PI * 0.2)
    g.stroke()
    for (let k = 0; k <= 8; k++) {
      const a = -Math.PI * 0.8 + (k / 8) * Math.PI * 0.6
      g.beginPath()
      g.moveTo(x + Math.cos(a) * 0.04, 0.085 + Math.sin(a) * 0.04)
      g.lineTo(x + Math.cos(a) * 0.045, 0.085 + Math.sin(a) * 0.045)
      g.stroke()
    }
    text(label, x, 0.07, 0.0065, "#1a1a1a", 700)
  }
  for (const [u, label] of knobsAt) {
    const x = W / 2 + u
    const y = H - 0.032
    // Dial scale round each knob.
    g.strokeStyle = "#1a1a1a"
    g.lineWidth = 0.0007
    for (let k = 0; k <= 10; k++) {
      const a = Math.PI * 0.75 + (k / 10) * Math.PI * 1.5
      g.beginPath()
      g.moveTo(x + Math.cos(a) * 0.019, y + Math.sin(a) * 0.019)
      g.lineTo(x + Math.cos(a) * 0.023, y + Math.sin(a) * 0.023)
      g.stroke()
    }
    text(label, x, y - 0.03, 0.0062, "#1a1a1a", 800)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  const m = new THREE.MeshStandardNodeMaterial({ map: t, roughness: 0.5, metalness: 0.3 })
  m.name = "interior_radio_faceplate"
  return m
}

/** A radio unit standing on a surface at (x, y, z), front facing `yaw` (−Z local). Returns its world box. */
export function radioUnit(b: Builder, m: THREE.Matrix4, opts: RadioUnitOpts) {
  const o: Required<RadioUnitOpts> = { w: 0.48, h: 0.18, d: 0.36, meters: [], knobs: [], tuning: false, panel: "#b9b9b0", ...opts }
  const { w, h, d } = o
  // Cabinet (sharp), the panel 2 mm proud of it, rack ears with handles, feet.
  b.rbox(CAB, m, w - 0.02, h - 0.004, d, 0.003, 0, h / 2, 0.006)
  for (const s of [-1, 1]) {
    b.boxM(EAR, m, 0.012, h, 0.004, s * (w / 2 - 0.006), h / 2, -d / 2 - 0.002)
    b.rod(EAR, sub(m, s * (w / 2 - 0.022), h * 0.2, -d / 2 - 0.004).elements.slice(12, 15) as unknown as [number, number, number], sub(m, s * (w / 2 - 0.022), h * 0.2, -d / 2 - 0.03).elements.slice(12, 15) as unknown as [number, number, number], 0.004, 6)
    b.rod(EAR, sub(m, s * (w / 2 - 0.022), h * 0.8, -d / 2 - 0.004).elements.slice(12, 15) as unknown as [number, number, number], sub(m, s * (w / 2 - 0.022), h * 0.8, -d / 2 - 0.03).elements.slice(12, 15) as unknown as [number, number, number], 0.004, 6)
    b.rod(EAR, sub(m, s * (w / 2 - 0.022), h * 0.2, -d / 2 - 0.03).elements.slice(12, 15) as unknown as [number, number, number], sub(m, s * (w / 2 - 0.022), h * 0.8, -d / 2 - 0.03).elements.slice(12, 15) as unknown as [number, number, number], 0.004, 6)
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxM(KNOB, m, 0.03, 0.006, 0.03, sx * (w / 2 - 0.05), 0.003, sz * (d / 2 - 0.05))
  const span = w - 0.12
  const knobsAt: [number, string][] = o.knobs.map((l, i) => [-span / 2 + (span * (i + 0.5)) / o.knobs.length, l])
  const metersAt: [number, string][] = o.meters.map((l, i) => [-span / 2 + (span * (i + 0.5)) / o.meters.length, l])
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.026, h - 0.006), faceplate({ ...o, w: w - 0.026, h: h - 0.006 }, knobsAt.map(([u, l]) => [-u, l]), metersAt.map(([u, l]) => [-u, l])))
  const pm = sub(m, 0, h / 2, -d / 2 + 0.006 - 0.0045).multiply(new THREE.Matrix4().makeRotationY(Math.PI))
  plate.applyMatrix4(pm)
  plate.position.y += b.oy
  plate.receiveShadow = true
  b.small.add(plate)
  // Meter glass and knobs (skirted, pointer line), a toggle between every pair.
  for (const [u] of metersAt) b.boxM(M.glass, m, 0.07, 0.046, 0.003, u, h - 0.053, -d / 2 - 0.0015, { cast: false })
  for (const [u] of knobsAt) {
    const k = sub(m, u, 0.032, -d / 2 + 0.006, 0, Math.PI / 2)
    b.cyl(SKIRT, k.clone().multiply(new THREE.Matrix4().makeTranslation(0, -0.006, 0)), 0.016, 0.016, 0.004, 20)
    b.cyl(KNOB, k.clone().multiply(new THREE.Matrix4().makeTranslation(0, -0.016, 0)), 0.011, 0.013, 0.016, 16)
  }
  for (let i = 0; i + 1 < knobsAt.length; i++) {
    const u = (knobsAt[i]![0] + knobsAt[i + 1]![0]) / 2
    b.boxM(EAR, m, 0.004, 0.004, 0.016, u, 0.045, -d / 2 - 0.004)
  }
}
