import { Mesh, MAT, FLOATS_PER_VERT, type Rgb } from "./mesh"
import { beam, cylinder } from "./city/kit"
import { barrier, bench, hydrant } from "./city/props"
import { SPECS, type PropKind } from "../game/props/placement"

const iron: Rgb = [.12, .15, .17], white: Rgb = [.83, .81, .7], wood: Rgb = [.49, .31, .15]

/** Small, closed, shared meshes. Origins at the mass centre, never at a hinge on the pavement. */
export function propMesh(kind: PropKind) {
  const m = new Mesh(), spec = SPECS[kind], c = spec.color
  const [w, h, d] = spec.size
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: Rgb = c) => m.box(x - sx / 2, x + sx / 2, y - sy / 2, y + sy / 2, z - sz / 2, z + sz / 2, color)
  switch (kind) {
    case "cone":
      box(0, .025, 0, w, .05, d, iron)
      m.prism(0, 0, .175, .025, .05, h, 8, c)
      m.prism(0, 0, .118, .091, .3, .42, 8, white)
      break
    case "barrier": barrier(m, 0, 0, true, w, 0); break
    case "sawhorse":
      box(0, h - .08, 0, w, .16, .12, wood)
      for (const x of [-.44, .44]) for (const s of [-1, 1]) {
        beam(m, [x, .025, s * .27], [x, h - .08, 0], .055, wood)
        box(x, .0125, s * .27, .07, .025, .06, wood)
      }
      break
    case "bench":
      bench(m, 0, 0, true, 0)
      break
    case "planter":
      m.prism(0, 0, .22, w / 2, 0, .45, 8, c)
      cylinder(m, 0, 0, .26, .45, .46, 8, [.16, .12, .07])
      for (const x of [-.1, .09]) m.prism(x, 0, .15, .025, .46, h, 5, [.19, .34, .15])
      break
    case "hydrant":
      hydrant(m, 0, 0, 0)
      break
    case "meter":
      cylinder(m, 0, 0, .04, 0, h - .28, 6, iron)
      box(0, h - .16, .01, w, .32, d - .02)
      box(0, h - .105, -.0875, .17, .1, .025, [.08, .13, .13])
      box(0, h - .245, -.0875, .08, .015, .025, iron)
      break
    case "sign":
      for (const s of [-1, 1]) {
        beam(m, [0, .025, s * .27], [0, 1, 0], .045, iron)
        box(0, .0125, s * .27, .12, .025, .06, iron)
      }
      box(0, h - .3, 0, w, .6, .05)
      box(0, h - .26, -.03, .06, .25, .01, iron)
      box(0, h - .47, -.03, .065, .065, .01, iron)
      break
    case "crate":
      box(0, h / 2, 0, w - .04, h, d - .08, wood)
      for (const s of [-1, 1]) for (const x of [-w / 2 + .05, w / 2 - .05]) box(x, h / 2, s * (d / 2 - .02), .1, h, .04, c)
      for (const y of [.1, h - .1]) box(0, y, -d / 2 + .02, w, .075, .04, c)
      break
    case "pallet":
      for (const x of [-.48, 0, .48]) box(x, .05, 0, .12, .1, d, wood)
      for (let i = 0; i < 5; i++) box(0, .125, -.42 + i * .21, w, .05, .16, c)
      break
    case "propane":
      cylinder(m, 0, 0, .125, 0, .06, 8, iron)
      m.prism(0, 0, .11, .16, .06, .12, 8, c)
      cylinder(m, 0, 0, .16, .12, .37, 8, c)
      m.prism(0, 0, .16, .06, .37, .43, 8, c)
      box(0, .465, 0, .1, .07, .07, iron)
      box(0, .24, -.155, .1, .11, .01, [.8, .16, .03])
      break
    case "fuel":
      cylinder(m, 0, 0, .28, 0, h, 12, c)
      for (const y of [.03, .25, .65, .84]) cylinder(m, 0, 0, .3, y, y + .035, 12, iron)
      box(0, .46, -.285, .2, .22, .02, white)
      box(0, .46, -.2975, .08, .12, .005, c)
      break
    case "canister":
      box(0, .19, 0, w, .38, d)
      box(-.1, .415, 0, .08, .07, .09, iron)
      box(.02, .4175, 0, .035, .075, .06)
      box(.13, .4175, 0, .035, .075, .06)
      box(.075, .4525, 0, .145, .035, .06)
      break
    case "bin":
      box(0, .5, 0, w - .05, .88, d - .05)
      box(0, h - .04, 0, w, .08, d, iron)
      for (const x of [-.24, .24]) box(x, .085, .245, .1, .17, .15, iron)
      for (const x of [-.2, 0, .2]) box(x, .49, -.31, .025, .6, .025, [.12, .26, .19])
      break
    case "dumpster":
      box(0, .65, 0, w - .05, .98, d - .07)
      box(0, h - .03, 0, w, .06, d, iron)
      for (const x of [-.72, .72]) for (const z of [-.45, .45]) box(x, .09, z, .15, .18, .14, iron)
      for (const x of [-.7, -.35, 0, .35, .7]) box(x, .66, -.5775, .045, .8, .025)
      break
    case "newspaper":
      box(0, .48, .01, w - .02, .96, d - .04)
      box(0, .7, -.205, .39, .37, .02, iron)
      box(0, .7, -.2175, .32, .28, .005, white)
      for (const y of [.64, .69, .74]) box(0, y, -.223, .24, .012, .004, iron)
      box(0, h - .02, 0, w, .04, d, white)
      break
    case "mailbox":
      for (const x of [-.17, .17]) box(x, .17, 0, .06, .34, .3, iron)
      box(0, .695, .01, w, .71, d - .02)
      box(0, h - .025, 0, w, .05, d)
      box(0, .89, -.213, .36, .04, .024, iron)
      box(0, .66, -.213, .22, .18, .024, white)
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
