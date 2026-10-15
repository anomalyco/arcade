import { MAT, Mesh, hex, type Rgb } from "@arcade/kit/gpu/mesh"
import { band, disc, figure, rings } from "./figure"
import type { Look } from "./types"

const A = MAT.actor
const INK = hex(0x101014)
const WHITE = hex(0xf6f4ef)

/** Two-sided quad, for capes and skirts. */
function sheet(m: Mesh, a: number[], b: number[], c: number[], d: number[], outer: Rgb, inner: Rgb): void {
  m.quadAuto(a, b, c, d, outer, A)
  m.quadAuto(d, c, b, a, inner, A)
}

/** Bea Buzzby: a towering brown bouffant, a gold blazer over black, a microphone. */
const bea: Look = {
  id: "bea",
  scale: 1,
  parts() {
    const p = figure({ skin: hex(0x9c6644), top: hex(0xe8b020), bottom: hex(0x1b1b22), shoes: hex(0x1b1b22) })
    p.torso.box(0.145, 0.22, -0.07, 0.16, 0.47, 0.07, INK, A)
    p.torso.box(0.15, 0.4, -0.08, 0.165, 0.43, 0.08, hex(0xffd84a), MAT.shiny)
    const hair = hex(0x5a3218)
    rings(p.head, [[-0.04, 0.19, 0.17], [-0.05, 0.27, 0.25], [-0.05, 0.39, 0.26], [-0.05, 0.48, 0.18], [-0.05, 0.53, 0]], hair, A, 12)
    p.head.box(-0.22, 0.04, -0.17, -0.06, 0.26, 0.17, hair, A)
    band(p.upperArm, -0.085, -0.17, -0.085, 0.085, -0.12, 0.085)
    return p
  },
  prop() {
    const m = new Mesh()
    m.box(-0.03, -0.31, -0.026, 0.13, -0.25, 0.026, INK, A)
    m.prism(0.17, 0, 0.055, 0.05, -0.335, -0.225, 8, hex(0xc9ccd6), MAT.shiny)
    return m
  },
}

/** The Great Presto: a tall top hat, a purple cape spread wide behind him, white gloves, a wand. */
const presto: Look = {
  id: "presto",
  scale: 1.04,
  parts() {
    const suit = hex(0x1a1426)
    const p = figure({ skin: hex(0xf0c8a8), top: suit, bottom: suit, shoes: hex(0x0c0c10), hands: WHITE })
    p.torso.box(0.145, 0.2, -0.06, 0.16, 0.45, 0.06, WHITE, A)
    p.torso.box(0.155, 0.42, -0.07, 0.175, 0.47, 0.07, hex(0x8f4dff), A)
    const purple = hex(0x7a3cff)
    const lining = hex(0xa0122e)
    sheet(p.torso, [-0.15, 0.47, 0.24], [-0.34, -0.56, 0.42], [-0.34, -0.56, -0.42], [-0.15, 0.47, -0.24], purple, lining)
    sheet(p.torso, [0.02, 0.48, 0.25], [-0.34, -0.56, 0.42], [-0.15, 0.47, 0.24], [0.02, 0.48, 0.25], purple, lining)
    sheet(p.torso, [-0.15, 0.47, -0.24], [-0.34, -0.56, -0.42], [0.02, 0.48, -0.25], [0.02, 0.48, -0.25], purple, lining)
    const hat = hex(0x15121c)
    disc(p.head, 0, 0.28, 0, 0.24, hat, A, 16, 0.025)
    p.head.prism(0, 0, 0.14, 0.15, 0.28, 0.62, 12, hat, A)
    p.head.prism(0, 0, 0.152, 0.152, 0.3, 0.36, 12, purple, A)
    p.head.box(0.14, 0.1, -0.06, 0.165, 0.125, 0.06, INK, A)
    band(p.upperArm, -0.085, -0.17, -0.085, 0.085, -0.12, 0.085)
    return p
  },
  prop() {
    const m = new Mesh()
    m.box(-0.02, -0.3, -0.016, 0.3, -0.268, 0.016, INK, A)
    m.box(0.3, -0.302, -0.02, 0.36, -0.266, 0.02, WHITE, MAT.glow, 1.2)
    return m
  },
}

/** Chef Flambé: a towering white toque, double-breasted whites and an apron, a red neckerchief, a frying pan. */
const chef: Look = {
  id: "chef",
  scale: 1.02,
  parts() {
    const p = figure({ skin: hex(0xf3c2a0), top: WHITE, bottom: hex(0x4f515a), shoes: INK })
    p.torso.bevelBox(0.1, 0.02, -0.17, 0.2, 0.34, 0.17, 0.05, WHITE, WHITE, A)
    for (const z of [-0.08, 0.08]) for (const y of [0.12, 0.22, 0.32]) p.torso.box(0.195, y, z - 0.018, 0.21, y + 0.03, z + 0.018, INK, A)
    p.torso.box(0.06, 0.42, -0.1, 0.17, 0.5, 0.1, hex(0xe0302a), A)
    sheet(p.pelvis, [0.15, 0.1, 0.18], [0.15, 0.1, -0.18], [0.2, -0.46, -0.2], [0.2, -0.46, 0.2], WHITE, WHITE)
    p.head.box(0.15, 0.115, -0.08, 0.175, 0.14, 0.08, INK, A)
    rings(p.head, [[0, 0.24, 0.155], [0, 0.33, 0.16]], WHITE, A, 12)
    rings(p.head, [[0, 0.33, 0.17], [0, 0.43, 0.215], [0, 0.57, 0.225], [0, 0.65, 0.17], [0, 0.69, 0]], WHITE, A, 12)
    band(p.upperArm, -0.085, -0.17, -0.085, 0.085, -0.12, 0.085)
    return p
  },
  prop() {
    const m = new Mesh()
    m.box(-0.03, -0.3, -0.022, 0.2, -0.26, 0.022, hex(0x3b2a20), A)
    m.prism(0.34, 0, 0.15, 0.13, -0.32, -0.27, 14, hex(0x2c2e35), MAT.shiny)
    disc(m, 0.34, -0.268, 0, 0.12, hex(0x4a4d57), MAT.shiny, 14, 0.004)
    return m
  },
}

/** Roxy Rollers: a lime helmet with a pink star, blue hair, a pink hoodie, knee pads and roller skates. */
const roxy: Look = {
  id: "roxy",
  scale: 0.96,
  parts() {
    const pink = hex(0xff4dad)
    const lime = hex(0xa6e22e)
    const skin = hex(0xc98e66)
    const p = figure({ skin, top: pink, bottom: hex(0x7a3fc8), shoes: pink, bareArms: true })
    p.thigh.box(-0.075, -0.43, -0.07, 0.075, -0.2, 0.07, skin, A)
    p.shin = new Mesh()
    p.shin.box(-0.065, -0.3, -0.065, 0.065, 0.03, 0.065, skin, A)
    p.shin.box(-0.07, -0.36, -0.07, 0.07, -0.26, 0.07, WHITE, A)
    p.shin.box(-0.08, -0.42, -0.076, 0.085, -0.34, 0.076, pink, A)
    p.shin.box(0.04, -0.07, -0.08, 0.11, 0.06, 0.08, lime, A)
    p.torso.box(0.15, 0.24, -0.09, 0.158, 0.38, 0.09, WHITE, A)
    p.head.box(-0.26, 0.04, -0.12, -0.12, 0.24, 0.12, hex(0x1e7fd8), A)
    rings(p.head, [[0, 0.17, 0.172], [0, 0.27, 0.175], [0, 0.34, 0.125], [0, 0.365, 0]], lime, A, 12)
    p.head.yawBox(0.04, 0.0, 0.12, 0.12, 0.35, 0.375, Math.PI / 4, pink, A)
    for (const z of [-1, 1]) p.head.box(0.08, 0.06, z * 0.15 - 0.03, 0.16, 0.2, z * 0.15 + 0.03, hex(0x1e7fd8), A)
    p.foreArm.box(-0.08, -0.04, -0.075, 0.08, 0.05, 0.075, lime, A)
    for (const x of [-0.04, 0.09]) for (const z of [-0.05, 0.05]) p.foot.box(x - 0.025, -0.14, z - 0.02, x + 0.025, -0.085, z + 0.02, lime, A)
    band(p.upperArm, -0.085, -0.12, -0.085, 0.085, -0.07, 0.085)
    return p
  },
}

/** Big Slab: huge, a red luchador mask and singlet, bare arms, red boots, a gold belt. */
const slab: Look = {
  id: "slab",
  scale: 1.28,
  parts() {
    const skin = hex(0xd08a5c)
    const red = hex(0xe8202e)
    const gold = hex(0xf2c230)
    const p = figure({ skin, top: skin, bottom: red, shoes: red, bareArms: true })
    p.torso = new Mesh()
    p.torso.box(-0.14, -0.02, -0.19, 0.15, 0.22, 0.19, red, A)
    p.torso.bevelBox(-0.17, 0.14, -0.27, 0.18, 0.48, 0.27, 0.07, red, skin, A)
    p.torso.box(-0.07, 0.44, -0.08, 0.07, 0.52, 0.08, skin, A)
    p.torso.box(-0.15, -0.03, -0.205, 0.16, 0.08, 0.205, gold, MAT.shiny)
    p.torso.box(0.15, -0.05, -0.1, 0.185, 0.12, 0.1, gold, MAT.shiny)
    p.shin.box(-0.085, -0.3, -0.08, 0.09, -0.26, 0.08, gold, MAT.shiny)
    p.upperArm = new Mesh()
    p.upperArm.box(-0.1, -0.29, -0.1, 0.1, 0.07, 0.1, skin, A)
    band(p.foreArm, -0.07, -0.2, -0.07, 0.075, -0.13, 0.07)
    p.head = new Mesh()
    p.head.box(-0.06, -0.02, -0.06, 0.06, 0.08, 0.06, red, A)
    rings(p.head, [[0, 0.04, 0], [0.01, 0.07, 0.14], [0.01, 0.17, 0.165], [0, 0.27, 0.14], [0, 0.315, 0]], red, A, 10)
    for (const z of [-1, 1]) {
      p.head.box(0.12, 0.15, z * 0.06 - 0.045, 0.165, 0.23, z * 0.06 + 0.045, WHITE, A)
      p.head.box(0.16, 0.17, z * 0.06 - 0.018, 0.172, 0.205, z * 0.06 + 0.018, INK, A)
    }
    p.head.box(0.13, 0.06, -0.05, 0.165, 0.1, 0.05, skin, A)
    p.head.box(-0.15, 0.29, -0.028, 0.15, 0.325, 0.028, WHITE, A)
    p.head.box(0.0, 0.2, -0.17, 0.08, 0.23, 0.17, WHITE, A)
    return p
  },
}

/** Granny Fern: an enormous straw sun hat, green overalls over a yellow shirt, round glasses, gloves and shears. */
const fern: Look = {
  id: "fern",
  scale: 0.88,
  parts() {
    const green = hex(0x4f9a3a)
    const p = figure({ skin: hex(0xf1c9a5), top: hex(0xf2cf3a), bottom: green, shoes: hex(0x6a4428), hands: hex(0x8a5a32) })
    p.torso.box(0.14, -0.02, -0.15, 0.16, 0.36, 0.15, green, A)
    p.torso.box(-0.16, -0.02, -0.15, -0.14, 0.3, 0.15, green, A)
    for (const z of [-0.1, 0.1]) p.torso.box(-0.16, 0.3, z - 0.025, 0.16, 0.47, z + 0.025, green, A)
    for (const z of [-0.07, 0.07]) p.head.box(0.15, 0.165, z - 0.045, 0.168, 0.225, z + 0.045, hex(0x3fae4a), A)
    p.head.box(-0.2, 0.08, -0.1, -0.1, 0.24, 0.1, hex(0xc8c8cc), A)
    const straw = hex(0xe9cf7a)
    disc(p.head, 0, 0.27, 0, 0.38, straw, A, 18, 0.03)
    rings(p.head, [[0, 0.27, 0.165], [0, 0.4, 0.16], [0, 0.44, 0.1], [0, 0.45, 0]], straw, A, 12)
    p.head.prism(0, 0, 0.17, 0.168, 0.27, 0.33, 12, hex(0x3a8a3a), A)
    p.head.box(0.12, 0.29, 0.08, 0.2, 0.36, 0.16, hex(0xff6fae), A)
    band(p.upperArm, -0.085, -0.17, -0.085, 0.085, -0.12, 0.085)
    return p
  },
  prop() {
    const m = new Mesh()
    const steel = hex(0xb8bcc6)
    m.box(-0.04, -0.31, -0.03, 0.1, -0.25, 0.03, hex(0xd9442a), A)
    m.yawBox(0.24, 0.02, 0.3, 0.035, -0.295, -0.275, 0.08, steel, MAT.shiny)
    m.yawBox(0.24, -0.02, 0.3, 0.035, -0.285, -0.265, -0.08, steel, MAT.shiny)
    return m
  },
}

export const LOOKS: Readonly<Record<string, Look>> = { bea, presto, chef, roxy, slab, fern }
