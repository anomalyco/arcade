import { MAT, Mesh, hex } from "@arcade/kit/gpu/mesh"

/** Models for ability projectiles, swarm members and zone dressing, at the origin with +x forward. */
export function abilityMeshes(): Record<string, Mesh> {
  const A = MAT.actor
  const card = new Mesh()
  card.box(-0.13, 0, -0.09, 0.13, 0.012, 0.09, hex(0xfdfcf6), A)
  card.box(-0.05, 0.012, -0.035, 0.05, 0.016, 0.035, hex(0xe0242c), A)

  const swap = new Mesh()
  swap.box(-0.2, 0, -0.14, 0.2, 0.02, 0.14, hex(0xc9a0ff), MAT.glow, 1.8)
  swap.box(-0.08, 0.02, -0.06, 0.08, 0.03, 0.06, hex(0xfff2ff), MAT.glow, 2.4)

  const pan = new Mesh()
  pan.prism(0, 0, 0.3, 0.26, 0, 0.09, 14, hex(0x2c2e35), MAT.shiny)
  pan.prism(0, 0, 0.24, 0.24, 0.09, 0.095, 14, hex(0xff8a2a), MAT.glow, 0.9)
  pan.box(-0.62, 0.05, -0.04, -0.28, 0.1, 0.04, hex(0x3b2a20), A)

  const seed = new Mesh()
  seed.prism(0, 0, 0.12, 0.09, -0.08, 0.08, 7, hex(0x7a4a22), A)
  seed.prism(0.02, 0, 0.03, 0.01, 0.08, 0.2, 5, hex(0x5fd35f), A)
  seed.box(0.0, 0.17, -0.09, 0.05, 0.19, 0.0, hex(0x5fd35f), A)

  const vine = new Mesh()
  const leaf = hex(0x4fbf3f), stem = hex(0x2f7f2a)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    vine.yawBox(Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0.42, 0.07, 0, 0.12 + (i % 2) * 0.1, a, i % 2 ? leaf : stem, A)
  }
  vine.prism(0, 0, 0.14, 0.06, 0, 0.38, 6, stem, A)
  vine.box(-0.04, 0.3, 0.02, 0.1, 0.34, 0.16, leaf, A)

  const bee = new Mesh()
  bee.box(-0.06, -0.04, -0.04, 0.06, 0.04, 0.04, hex(0xffcf2a), MAT.glow, 0.7)
  bee.box(-0.015, -0.045, -0.045, 0.015, 0.045, 0.045, hex(0x15151a), A)
  bee.box(-0.07, -0.03, -0.03, -0.055, 0.03, 0.03, hex(0x15151a), A)
  bee.box(-0.02, 0.04, -0.09, 0.03, 0.05, 0.09, hex(0xf2f6ff), MAT.glow, 0.6)

  const bramble = new Mesh()
  const thorn = hex(0x3c8a2e), dark = hex(0x24561c)
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3
    bramble.yawBox(Math.cos(a) * 0.25, Math.sin(a) * 0.25, 0.6, 0.06, 0, 0.18 + (i % 3) * 0.07, a + 0.6, i % 2 ? thorn : dark, A)
  }
  bramble.prism(0, 0, 0.16, 0.05, 0, 0.45, 5, dark, A)
  bramble.box(0.08, 0.36, -0.04, 0.16, 0.42, 0.04, hex(0xff6fae), A)

  return { card, swap, pan, seed, vine, bee, bramble }
}
