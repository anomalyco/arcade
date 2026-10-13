import { Mesh, MAT, FLOATS_PER_VERT, type Rgb } from "./mesh"
import { beam, cylinder } from "./city/kit"
import { barrier } from "./city/props"
import { SPECS, type PropKind } from "../game/props/placement"

const iron: Rgb = [.12, .15, .17], white: Rgb = [.83, .81, .7], wood: Rgb = [.49, .31, .15]

/** Small, closed, shared meshes. Origins at the mass centre, never at a hinge on the pavement. */
export function propMesh(kind: PropKind) {
  const m = new Mesh(), spec = SPECS[kind], c = spec.color
  const [w, h, d] = spec.size
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: Rgb = c) => m.box(x - sx / 2, x + sx / 2, y - sy / 2, y + sy / 2, z - sz / 2, z + sz / 2, color)
  switch (kind) {
    case "cone":
      box(0, .05, 0, w, .1, d, iron)
      m.prism(0, 0, .27, .06, .1, .95, 7, c)
      m.prism(0, 0, .19, .15, .43, .6, 7, white)
      break
    case "barrier": barrier(m, 0, 0, true, w, 0); break
    case "sawhorse":
      box(0, .88, 0, w, .25, .16, wood)
      for (const x of [-.75, .75]) for (const s of [-1, 1]) beam(m, [x, .05, s * .34], [x, 1, 0], .075, wood)
      break
    case "bench":
      for (const z of [-.25, 0, .25]) box(0, .48, z, w, .09, .19, wood)
      for (const y of [.7, .91]) box(0, y, .34, w, .16, .08, wood)
      for (const x of [-.9, .9]) {
        for (const z of [-.25, .28]) box(x, .24, z, .09, .48, .09, iron)
        box(x, .73, .32, .07, .5, .07, iron)
      }
      break
    case "planter":
      m.prism(0, 0, .35, .5, 0, .7, 6, c)
      cylinder(m, 0, 0, .43, .7, .72, 6, [.16, .12, .07])
      for (const x of [-.22, .17]) m.prism(x, 0, .28, .06, .7, 1.15, 5, [.19, .34, .15])
      break
    case "hydrant":
      cylinder(m, 0, 0, .25, 0, .12, 7, iron)
      cylinder(m, 0, 0, .18, .12, .75, 7, c)
      m.prism(0, 0, .23, .06, .75, .95, 7, c)
      box(0, .52, 0, .6, .16, .17, c)
      break
    case "meter":
      cylinder(m, 0, 0, .055, 0, 1.12, 5, iron)
      box(0, 1.36, 0, .32, .48, .25)
      box(0, 1.44, -.132, .22, .14, .02, [.08, .13, .13])
      box(0, 1.25, -.132, .12, .025, .02, iron)
      break
    case "sign":
      for (const s of [-1, 1]) beam(m, [0, .02, s * .34], [0, 1.3, 0], .05, iron)
      box(0, 1.2, 0, .9, .9, .06)
      box(0, 1.24, -.04, .09, .4, .02, iron)
      box(0, .94, -.04, .1, .1, .02, iron)
      break
    case "crate":
      box(0, h / 2, 0, w, h, d, wood)
      for (const s of [-1, 1]) for (const x of [-.4, .4]) box(x, h / 2, s * .56, .1, h, .055, c)
      for (const y of [.15, .95]) box(0, y, -.59, w, .1, .06, c)
      break
    case "pallet":
      for (const x of [-.5, 0, .5]) box(x, .07, 0, .15, .14, d, wood)
      for (let z = -.48; z <= .5; z += .24) box(0, .18, z, w, .08, .17, c)
      break
    case "propane":
      cylinder(m, 0, 0, .27, .06, .15, 8, iron)
      m.prism(0, 0, .22, .32, .15, .3, 8, c)
      cylinder(m, 0, 0, .32, .3, .79, 8, c)
      m.prism(0, 0, .32, .13, .79, .95, 8, c)
      box(0, 1.02, 0, .2, .16, .15, iron)
      box(0, .55, -.325, .22, .22, .015, [.8, .16, .03])
      break
    case "fuel":
      cylinder(m, 0, 0, .4, 0, h, 10, c)
      for (const y of [.1, .38, .92, 1.16]) cylinder(m, 0, 0, .43, y, y + .06, 10, iron)
      box(0, .67, -.405, .3, .3, .03, white)
      box(0, .67, -.425, .12, .17, .02, c)
      break
    case "canister":
      box(0, .28, 0, w, .56, d)
      box(-.15, .62, 0, .13, .16, .15, iron)
      beam(m, [.08, .52, 0], [.08, .68, 0], .055, c)
      beam(m, [.08, .68, 0], [.23, .53, 0], .055, c)
      break
    case "bin":
      box(0, .54, 0, .7, 1.02, .7)
      box(0, 1.08, 0, .8, .13, .8, iron)
      for (const x of [-.3, .3]) box(x, .11, .32, .12, .22, .16, iron)
      for (const x of [-.24, 0, .24]) box(x, .55, -.355, .035, .65, .03, [.12, .26, .19])
      break
    case "dumpster":
      box(0, .85, 0, w, 1.3, d)
      box(0, 1.53, 0, w + .05, .14, d + .05, iron)
      for (const x of [-.85, .85]) for (const z of [-.45, .45]) box(x, .12, z, .2, .24, .18, iron)
      for (const x of [-.85, -.42, 0, .42, .85]) box(x, .8, -.64, .06, 1.05, .05)
      break
    case "newspaper":
      box(0, .64, 0, w, 1.22, d)
      box(0, .87, -.36, .51, .48, .025, iron)
      box(0, .87, -.38, .41, .36, .025, white)
      for (const y of [.79, .84, .9]) box(0, y, -.4, .3, .016, .015, iron)
      box(0, 1.22, 0, w + .05, .06, d + .05, white)
      break
    case "mailbox":
      for (const x of [-.22, .22]) box(x, .22, 0, .07, .44, .38, iron)
      box(0, .85, 0, w, .9, d)
      m.prism(0, 0, .36, .22, 1.3, 1.4, 6, c)
      box(0, 1.06, -.34, .5, .06, .04, iron)
      box(0, .78, -.34, .29, .23, .015, white)
      break
  }
  for (let i = 1; i < m.v.length; i += FLOATS_PER_VERT) m.v[i] -= h / 2
  return m
}

export function chunkMesh(color: Rgb, board: boolean) {
  const m = new Mesh()
  m.box(-.5, .5, board ? -.07 : -.3, board ? .07 : .3, -.22, .22, color, MAT.lit)
  return m
}
