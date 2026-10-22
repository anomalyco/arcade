import { Mesh, hex } from "@arcade/kit/gpu/mesh"
import { SURFACE, box, tube } from "../world"

const seam = hex(0x1d1f1b), steel = hex(0x8d8a80), wood = hex(0x3e2a1f), kick = hex(0x4b4a44), plate = hex(0x7e7b70)
const button = hex(0x3a3830)

/**
 * A worn 1980s car fitted inside the elevator's shell (car origin at x 0, doorway at z 9, back wall's inner face at
 * z 10.79, side walls' at x ±1.04): walnut-laminate wainscot under brushed steel panels with dark seams, a scuffed kick
 * plate, a proper button panel with one lit button and an egg-crate ceiling light that flickers. Grime gathers in the
 * corners in the shader (`carGrime`).
 */
export function carLiner(): Mesh {
  const m = new Mesh()
  const panels = (along: "x" | "z", fixed: number, from: number, to: number, count: number, face: number, steelTop = 2.44) => {
    const step = (to - from) / count
    for (let i = 0; i < count; i++) {
      const c = from + step * (i + .5), w = step - .012
      const put = (y: number, h: number, color: typeof steel, s: number, depth: number) => along === "z"
        ? box(m, fixed - face * depth / 2, y, c, depth, h, w, color, s)
        : box(m, c, y, fixed - face * depth / 2, w, h, depth, color, s)
      put(.13, .84, wood, SURFACE.carWood, .012)
      put(1.04, steelTop - 1.04, steel, SURFACE.carSteel, .01)
    }
    // Seams and the chair rail between wood and steel, then the kick plate.
    const full = (y: number, h: number, color: typeof steel, s: number, depth: number) => along === "z"
      ? box(m, fixed - face * depth / 2, y, (from + to) / 2, depth, h, to - from, color, s)
      : box(m, (from + to) / 2, y, fixed - face * depth / 2, to - from, h, depth, color, s)
    full(.12, 2.34, seam, SURFACE.metal, .006)
    full(.97, .07, plate, SURFACE.carSteel, .02)
    full(0, .13, kick, SURFACE.carSteel, .016)
  }
  for (const side of [-1, 1]) panels("z", side * 1.04, 9.17, 10.79, 3, side)
  // The back wall's steel stops under the descent's floor display (z 10.781, x ±.22, y 2.13–2.34) and frames it.
  panels("x", 10.79, -1.04, 1.04, 3, 1, 2.1)
  for (const sx of [-1, 1]) box(m, sx * .64, 2.1, 10.785, .8, .34, .01, steel, SURFACE.carSteel)
  box(m, 0, 2.355, 10.785, .48, .085, .01, steel, SURFACE.carSteel)

  // Button panel on the right-hand wall around the descent's lit B (its display at x .899, z 9.55–9.65,
  // y 1.13–1.235 shows through a window): brushed faceplate, two columns of round floor buttons, a key switch
  // and a speaker grille. The B is the only lit button.
  const px = .883, pz = 9.6, back = 1.03, plateColor = hex(0x5d5b54)
  const faceplate = (y0: number, y1: number, z0: number, z1: number) => box(m, (px + back) / 2, y0, (z0 + z1) / 2, back - px, y1 - y0, z1 - z0, plateColor, SURFACE.carSteel)
  faceplate(.86, 1.13, 9.465, 9.735); faceplate(1.235, 1.52, 9.465, 9.735); faceplate(1.13, 1.235, 9.465, 9.55); faceplate(1.13, 1.235, 9.65, 9.735)
  for (const y of [.9, .96, 1.02, 1.08, 1.29, 1.35]) for (const col of [-1, 1]) {
    const z = pz + col * .05
    box(m, px - .003, y - .016, z, .006, .032, .032, button, SURFACE.metal, .006)
    box(m, px - .008, y - .012, z, .006, .024, .024, hex(0x6f6a5c), SURFACE.plastic, .005)
  }
  box(m, px - .004, 1.42, pz, .008, .04, .08, button, SURFACE.metal, .004)
  tube(m, [px - .008, 1.44, pz + .02], [px - .016, 1.44, pz + .02], .007, hex(0xa49a72), SURFACE.metal, 8)
  for (let i = 0; i < 4; i++) box(m, px - .002, 1.47 + i * .011, pz, .004, .004, .13, seam, SURFACE.metal)

  // Egg-crate diffuser under the existing ceiling light, with a dark steel frame.
  box(m, 0, 2.47, 10, .74, .03, .46, seam, SURFACE.metal, .004)
  box(m, 0, 2.465, 10, .68, .006, .4, hex(0xe6b36d), SURFACE.carLight)
  for (let i = 1; i < 8; i++) box(m, -.34 + i * .085, 2.455, 10, .006, .012, .4, seam, SURFACE.metal)
  for (let i = 1; i < 5; i++) box(m, 0, 2.455, 9.8 + i * .08, .68, .012, .006, seam, SURFACE.metal)
  return m
}
