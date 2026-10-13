import type { Gun } from "../../shared/config"
import { MAT, Mesh, type Mat, type Rgb } from "./mesh"
import { hex } from "./models"
import { personModels, type PersonModels } from "./person"

const CLOTH: Rgb = [0.85, 0.85, 0.85]
const DARK = hex(0x13151e), LEATHER = hex(0x35261f), GOLD = hex(0xb98a42)

/** Offset polygon rings make the hat bend without adding a bone to the soldier rig. */
function rings(m: Mesh, rows: readonly (readonly [number, number, number])[], color: Rgb, material: Mat = MAT.cloth, sides = 8): void {
  for (let j = 1; j < rows.length; j++) {
    const [x0, y0, r0] = rows[j - 1]!, [x1, y1, r1] = rows[j]!
    for (let i = 0; i < sides; i++) {
      const a = i * Math.PI * 2 / sides, b = (i + 1) * Math.PI * 2 / sides
      if (r1 === 0) {
        m.facet([x0 + Math.cos(a) * r0, y0, Math.sin(a) * r0], [x1, y1, 0], [x0 + Math.cos(b) * r0, y0, Math.sin(b) * r0], color, material)
        continue
      }
      m.quadAuto([x0 + Math.cos(a) * r0, y0, Math.sin(a) * r0], [x1 + Math.cos(a) * r1, y1, Math.sin(a) * r1], [x1 + Math.cos(b) * r1, y1, Math.sin(b) * r1], [x0 + Math.cos(b) * r0, y0, Math.sin(b) * r0], color, material)
    }
  }
}

function buckle(m: Mesh, x: number, y: number, z = 0): void {
  m.box(x, y, z - 0.07, x + 0.025, y + 0.11, z + 0.07, GOLD, MAT.actor)
  m.box(x + 0.025, y + 0.022, z - 0.047, x + 0.029, y + 0.088, z + 0.047, DARK, MAT.actor)
}

/** Three prop-only spell implements, with the existing gun's grip at the origin. */
export function wizardWeapon(gun: Gun): Mesh {
  const m = new Mesh()
  const wood = hex(0x684226), iron = hex(0x232635)
  if (gun === "rifle") {
    // Frog Fountain: crooked staff, a stone basin, water gem and a squat frog idol.
    rings(m, [[0, -1.02, 0.035], [0.02, -0.25, 0.043], [0.18, 0.4, 0.048], [0.28, 0.66, 0.045]], wood, MAT.actor, 6)
    m.prism(0.28, 0, 0.19, 0.24, 0.57, 0.69, 8, hex(0x606661), MAT.actor)
    m.prism(0.28, 0, 0.2, 0.2, 0.69, 0.71, 8, hex(0x42cbdc), MAT.glow, 1.1)
    m.prism(0.28, 0, 0.065, 0.1, 0.7, 0.86, 5, hex(0x8effbd), MAT.glow, 1.5)
    m.prism(0.28, 0, 0.1, 0, 0.86, 1.02, 5, hex(0x8effbd), MAT.glow, 1.5)
    m.box(0.24, 0.73, -0.13, 0.46, 0.85, 0.13, hex(0x73a51a), MAT.actor)
    for (const z of [-0.105, 0.105]) {
      m.prism(0.42, z, 0.067, 0.047, 0.81, 0.9, 6, hex(0xa6d638), MAT.actor)
      m.box(0.462, 0.84, z - 0.022, 0.48, 0.88, z + 0.022, DARK, MAT.actor)
      m.box(0.22, 0.71, z - 0.055, 0.52, 0.75, z + 0.055, hex(0x619622), MAT.actor)
    }
  } else if (gun === "shotgun") {
    // Thunder Lantern: iron cage, hanging handle, faceted amber core.
    m.box(-0.025, -0.03, -0.035, 0.35, 0.02, 0.035, LEATHER, MAT.actor)
    for (const z of [-0.12, 0.12]) m.box(0.3, -0.15, z - 0.016, 0.33, 0.08, z + 0.016, iron, MAT.actor)
    m.box(0.3, 0.05, -0.13, 0.33, 0.085, 0.13, GOLD, MAT.actor)
    m.prism(0.32, 0, 0.23, 0.21, -0.54, -0.48, 6, iron, MAT.actor)
    m.prism(0.32, 0, 0.24, 0.1, -0.19, -0.12, 6, GOLD, MAT.actor)
    m.prism(0.32, 0, 0.12, 0.14, -0.47, -0.33, 6, hex(0xffad28), MAT.glow, 2)
    m.prism(0.32, 0, 0.14, 0.02, -0.33, -0.19, 6, hex(0xffdf73), MAT.glow, 2)
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3, x = 0.32 + Math.cos(a) * 0.2, z = Math.sin(a) * 0.2
      m.box(x - 0.018, -0.49, z - 0.018, x + 0.018, -0.18, z + 0.018, iron, MAT.actor)
    }
  } else {
    // Ice Saw: double-sided icy disc, with swept teeth and a dark hub.
    m.box(-0.03, -0.045, -0.035, 0.35, 0.025, 0.035, LEATHER, MAT.actor)
    const cx = 0.48, cy = 0.12
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6, b = a + Math.PI / 6
      const p = (r: number, t: number, z: number) => [cx + Math.cos(t) * r, cy + Math.sin(t) * r, z]
      for (const z of [-0.035, 0.035]) {
        const pts = [[cx, cy, z], p(0.28, a, z), p(0.28, b, z)]
        if (z < 0) pts.reverse()
        m.facet(pts[0]!, pts[1]!, pts[2]!, i % 2 ? hex(0x399ecf) : hex(0x79d4f5), MAT.glow, 0.65)
        const tooth = [p(0.25, a, z), p(0.4, b + 0.12, z), p(0.27, b, z)]
        if (z < 0) tooth.reverse()
        m.facet(tooth[0]!, tooth[1]!, tooth[2]!, hex(0xb3eeff), MAT.glow, 1.2)
      }
    }
    m.box(cx - 0.07, cy - 0.07, -0.055, cx + 0.07, cy + 0.07, 0.055, iron, MAT.actor)
  }
  return m
}

export function wizardModels(): PersonModels {
  const p = personModels()
  p.pelvis = new Mesh()
  rings(p.pelvis, [[0, -0.54, 0.43], [0, -0.27, 0.31], [0, 0.1, 0.2]], CLOTH)
  // The two forward panels form a dark inner robe beneath the open coloured coat.
  for (let i = 0; i < p.pelvis.v.length; i += 11) if (p.pelvis.v[i + 3]! > 0.8) {
    p.pelvis.v.splice(i + 6, 3, ...DARK)
    p.pelvis.v[i + 9] = MAT.actor
  }
  // Dark centre panel, leather belt and pouch keep the saturated robe grounded.
  p.pelvis.prism(0, 0, 0.215, 0.215, 0.04, 0.13, 8, LEATHER, MAT.actor)
  buckle(p.pelvis, 0.205, 0.025)
  p.pelvis.box(0.05, -0.16, 0.2, 0.19, 0.07, 0.3, LEATHER, MAT.actor)
  p.torso = new Mesh()
  rings(p.torso, [[0, -0.01, 0.21], [0, 0.34, 0.27], [0, 0.46, 0.19]], CLOTH)
  p.torso.prism(0, 0, 0.25, 0.16, 0.36, 0.51, 8, DARK, MAT.actor)
  p.torso.box(-0.31, 0.09, -0.15, -0.2, 0.4, 0.15, LEATHER, MAT.actor)
  p.head = new Mesh()
  p.head.prism(0, 0, 0.15, 0.19, 0.015, 0.25, 8, DARK, MAT.actor)
  for (const z of [-0.078, 0.078]) p.head.box(0.154, 0.1, z - 0.024, 0.18, 0.15, z + 0.024, [1, 1, 1], MAT.accent)
  rings(p.head, [[0, 0.2, 0.16], [0, 0.215, 0.43], [-0.02, 0.265, 0.4], [-0.02, 0.29, 0.23], [-0.04, 0.5, 0.18], [-0.12, 0.74, 0.11], [-0.32, 0.81, 0.075], [-0.46, 0.62, 0]], CLOTH)
  rings(p.head, [[-0.02, 0.28, 0.24], [-0.035, 0.38, 0.216]], LEATHER, MAT.actor)
  buckle(p.head, 0.2, 0.28, 0.025)
  p.upperArm = new Mesh()
  rings(p.upperArm, [[0, -0.29, 0.13], [0, -0.04, 0.14], [0, 0.05, 0.1]], CLOTH)
  p.foreArm = new Mesh()
  rings(p.foreArm, [[0, -0.23, 0.16], [0, 0.02, 0.095]], CLOTH)
  p.foreArm.prism(0, 0, 0.155, 0.155, -0.232, -0.228, 8, DARK, MAT.actor)
  p.foreArm.box(-0.05, -0.32, -0.045, 0.06, -0.22, 0.045, LEATHER, MAT.actor)
  p.thigh = new Mesh()
  p.thigh.prism(0, 0, 0.065, 0.075, -0.43, 0.04, 6, DARK, MAT.actor)
  p.shin = new Mesh()
  p.shin.prism(0, 0, 0.07, 0.06, -0.41, 0.02, 6, LEATHER, MAT.actor)
  p.pump = new Mesh()
  p.mag = { rifle: new Mesh(), shotgun: new Mesh(), sniper: new Mesh() }
  p.gun = { rifle: wizardWeapon("rifle"), shotgun: wizardWeapon("shotgun"), sniper: wizardWeapon("sniper") }
  return p
}
