import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { hex } from "../level"

/**
 * Fire & explosives items as small props lying on the ground (origin at the base centre, long axis along +x), read
 * by shape and colour: a red jerry can, a grey pressure tank, a tank-and-wand flamethrower, a taped bundle of red
 * sticks, a braid of red firecrackers, a bottle with a rag in its neck, a stubby orange flare gun, a steel trap.
 */
export function buildFireItemMeshes(): Record<string, Mesh> {
  const out: Record<string, Mesh> = {}
  const steel = hex(0x3a3d40)
  const red = hex(0x9a2418)

  const fuel = new Mesh()
  fuel.bevelBox(-0.13, 0, -0.07, 0.13, 0.26, 0.07, 0.015, red, hex(0xb02c1e), MAT.shiny)
  fuel.box(-0.1, 0.26, -0.02, 0.02, 0.29, 0.02, hex(0x2a2a2a), MAT.shiny)
  fuel.yawBox(0.09, 0, 0.06, 0.025, 0.26, 0.31, 0.6, hex(0xb8a050), MAT.shiny)
  fuel.box(-0.131, 0.08, -0.04, -0.129, 0.2, 0.04, hex(0x6a1810))
  out.fuel = fuel

  const tank = new Mesh()
  tank.yawBox(0, 0, 0.34, 0.15, 0, 0.15, 0, hex(0x7c8286), MAT.shiny)
  tank.yawBox(0.19, 0, 0.05, 0.06, 0.05, 0.11, 0, hex(0x9a9f6a), MAT.shiny)
  tank.yawBox(-0.1, 0, 0.02, 0.152, 0, 0.152, 0, hex(0xb8b030), MAT.lit)
  out["pressure-tank"] = tank

  const flamer = new Mesh()
  for (const z of [-0.07, 0.07]) flamer.yawBox(-0.08, z, 0.36, 0.13, 0, 0.13, 0, hex(0x8a2a1e), MAT.shiny)
  flamer.yawBox(0.25, 0.1, 0.42, 0.04, 0, 0.04, 0, steel, MAT.shiny)
  flamer.yawBox(0.47, 0.1, 0.06, 0.06, 0, 0.06, 0, hex(0x1e2022), MAT.shiny)
  flamer.yawBox(0.12, 0.06, 0.2, 0.02, 0, 0.02, 0.5, hex(0x1a1a1a), MAT.lit)
  out.flamethrower = flamer

  const dyn = new Mesh()
  for (const [z, y] of [[-0.024, 0], [0.024, 0], [0, 0.04]] as const) dyn.yawBox(0, z, 0.2, 0.044, y, y + 0.044, 0, hex(0xa82a1c), MAT.lit)
  for (const x of [-0.06, 0.06]) dyn.yawBox(x, 0, 0.022, 0.1, 0, 0.088, 0, hex(0x2a2826), MAT.lit)
  dyn.yawBox(0.12, 0.01, 0.06, 0.006, 0.06, 0.066, 0.2, hex(0xd8d0b8), MAT.lit)
  out.dynamite = dyn

  const crackers = new Mesh()
  for (let i = 0; i < 8; i++) crackers.yawBox(-0.07 + i * 0.02, (i % 2 ? 1 : -1) * 0.012, 0.022, 0.018, 0, 0.022, 0.4 * (i % 2 ? 1 : -1), hex(0xc02a20), MAT.lit)
  crackers.yawBox(0.11, 0, 0.06, 0.004, 0.01, 0.014, 0, hex(0x3a3028), MAT.lit)
  out.firecrackers = crackers

  const molotov = new Mesh()
  const glass = hex(0x6a4a1e)
  molotov.yawBox(-0.04, 0, 0.15, 0.065, 0, 0.065, 0, glass, MAT.glass)
  molotov.yawBox(0.06, 0, 0.05, 0.045, 0.01, 0.055, 0, glass, MAT.glass)
  molotov.yawBox(0.105, 0, 0.04, 0.026, 0.02, 0.046, 0, glass, MAT.glass)
  molotov.yawBox(0.15, 0.005, 0.07, 0.04, 0.02, 0.05, 0.3, hex(0xd8ccb0), MAT.cloth)
  out.molotov = molotov

  const gun = new Mesh()
  gun.box(-0.06, 0, -0.025, 0.12, 0.05, 0.025, hex(0xd8661e), MAT.shiny)
  gun.prism(0.12, 0, 0.03, 0.03, 0, 0.05, 10, hex(0xe07428), MAT.shiny)
  gun.box(-0.06, 0, 0.025, -0.01, 0.04, 0.1, hex(0xc85a18), MAT.shiny)
  out["flare-gun"] = gun

  const trap = bearTrapMesh(false)
  out["bear-trap"] = trap
  return out
}

/** A bear trap, open (jaws flat in a ring) or sprung (jaws up and shut). Centred on its pan. */
export function bearTrapMesh(shut: boolean): Mesh {
  const m = new Mesh()
  const steel = hex(0x34373a)
  const rust = hex(0x5a3a26)
  m.prism(0, 0, 0.045, 0.045, 0, 0.012, 10, rust, MAT.shiny)
  m.box(-0.26, 0, -0.012, 0.26, 0.014, 0.012, steel, MAT.shiny)
  if (!shut) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      const r = 0.19
      m.yawBox(Math.cos(a) * r, Math.sin(a) * r, 0.08, 0.012, 0, 0.01, a + Math.PI / 2, steel, MAT.shiny)
      if (i % 2 === 0) m.yawBox(Math.cos(a) * (r - 0.02), Math.sin(a) * (r - 0.02), 0.012, 0.012, 0.008, 0.03, a, hex(0x8a8e90), MAT.shiny)
    }
  } else {
    for (const s of [-1, 1]) {
      m.box(-0.19, 0, s * 0.012, 0.19, 0.16, s * 0.026, steel, MAT.shiny)
      for (let i = 0; i < 7; i++) m.box(-0.16 + i * 0.053, 0.16, s * 0.004, -0.15 + i * 0.053, 0.19, s * 0.02, hex(0x8a8e90), MAT.shiny)
    }
  }
  return m
}
