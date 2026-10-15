import { personModels, type PersonModels } from "@arcade/kit/avatar/soldier"
import { MAT, Mesh, type Mat, type Rgb } from "@arcade/kit/gpu/mesh"

/** Fighter part meshes: the shared rig's parts, re-dressed per character. */
export type Parts = PersonModels

export type Palette = {
  skin: Rgb
  /** Jacket or shirt, and its sleeves. */
  top: Rgb
  sleeve?: Rgb
  bottom: Rgb
  shoes: Rgb
  /** Hands; defaults to skin (gloves otherwise). */
  hands?: Rgb
  /** Bare forearms (rolled sleeves, wrestlers). */
  bareArms?: boolean
}

const A = MAT.actor

/** Faceted rings stacked along y: [x offset, y, radius] rows, for hats, hair and bellies. */
export function rings(m: Mesh, rows: readonly (readonly [number, number, number])[], color: Rgb, material: Mat = A, sides = 10, zs = 1): void {
  for (let j = 1; j < rows.length; j++) {
    const [x0, y0, r0] = rows[j - 1]!
    const [x1, y1, r1] = rows[j]!
    for (let i = 0; i < sides; i++) {
      const a = (i * Math.PI * 2) / sides
      const b = ((i + 1) * Math.PI * 2) / sides
      const p = (x: number, y: number, r: number, t: number) => [x + Math.cos(t) * r, y, Math.sin(t) * r * zs]
      if (r1 === 0) m.facet(p(x0, y0, r0, a), [x1, y1, 0], p(x0, y0, r0, b), color, material)
      else if (r0 === 0) m.facet([x0, y0, 0], p(x1, y1, r1, a), p(x1, y1, r1, b), color, material)
      else m.quadAuto(p(x0, y0, r0, a), p(x1, y1, r1, a), p(x1, y1, r1, b), p(x0, y0, r0, b), color, material)
    }
  }
}

/** A flat disc (hat brim, pan) facing up at height y. */
export function disc(m: Mesh, cx: number, y: number, cz: number, r: number, color: Rgb, material: Mat = A, sides = 14, thick = 0.02): void {
  m.prism(cx, cz, r, r, y - thick, y, sides, color, material)
}

/**
 * A plain cartoon figure on the shared rig: chunky limbs, a round head with eyes, no gear. Characters start here and
 * add their silhouette (hair, hats, capes, skates) on top.
 */
export function figure(p: Palette): Parts {
  const parts = personModels()
  const sleeve = p.sleeve ?? p.top
  const hands = p.hands ?? p.skin
  const pelvis = new Mesh()
  pelvis.box(-0.13, -0.09, -0.19, 0.12, 0.11, 0.19, p.bottom, A)
  const torso = new Mesh()
  torso.box(-0.13, -0.02, -0.17, 0.12, 0.22, 0.17, p.top, A)
  torso.bevelBox(-0.15, 0.16, -0.22, 0.15, 0.46, 0.22, 0.05, p.top, p.top, A)
  torso.box(-0.06, 0.44, -0.06, 0.06, 0.52, 0.06, p.skin, A)
  const head = new Mesh()
  head.box(-0.05, -0.02, -0.05, 0.05, 0.08, 0.05, p.skin, A)
  rings(head, [[0, 0.04, 0], [0.01, 0.07, 0.13], [0.01, 0.17, 0.155], [0, 0.27, 0.13], [0, 0.31, 0]], p.skin, A, 10)
  // Eyes: two dark dots on the face, readable even from above at a glance.
  for (const z of [-0.055, 0.055]) head.box(0.135, 0.17, z - 0.022, 0.16, 0.21, z + 0.022, [0.05, 0.05, 0.07], A)
  const upperArm = new Mesh()
  upperArm.box(-0.08, -0.29, -0.08, 0.08, 0.06, 0.08, sleeve, A)
  const foreArm = new Mesh()
  foreArm.box(-0.065, -0.23, -0.065, 0.065, 0.04, 0.065, p.bareArms ? p.skin : sleeve, A)
  foreArm.box(-0.06, -0.34, -0.055, 0.07, -0.21, 0.055, hands, A)
  const thigh = new Mesh()
  thigh.box(-0.09, -0.43, -0.085, 0.09, 0.05, 0.085, p.bottom, A)
  const shin = new Mesh()
  shin.box(-0.07, -0.36, -0.07, 0.07, 0.03, 0.07, p.bottom, A)
  shin.box(-0.08, -0.42, -0.076, 0.085, -0.3, 0.076, p.shoes, A)
  const foot = new Mesh()
  foot.box(-0.08, -0.085, -0.07, 0.13, 0.03, 0.07, p.shoes, A)
  const toe = new Mesh()
  toe.box(-0.01, 0, -0.068, 0.07, 0.085, 0.068, p.shoes, A)
  Object.assign(parts, { pelvis, torso, head, upperArm, foreArm, thigh, shin, foot, toe })
  return parts
}

/** A small band in the player's slot colour (the instance tint), so two of the same character stay apart. */
export function band(m: Mesh, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  m.box(x0, y0, z0, x1, y1, z1, [1, 1, 1], MAT.accent)
}
