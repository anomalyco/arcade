import { MAT, Mesh } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { MELEE_WEAPON_IDS } from "../../shared/combat"
import { hex } from "../level"
import { buildFireItemMeshes } from "../fire/items"
import { buildMeleeWeaponMeshes } from "../survivor"

/** Each item as a small prop, origin at its base centre, long axis along +x. Read by shape and colour, never a label. */
export type ItemModels = { model: (item: string) => number | undefined; footprint: (item: string) => number }

/** Rough length of each prop along x, for laying several side by side. */
const FOOTPRINT: Record<string, number> = {
  ammo: 0.17,
  medkit: 0.24,
  bandage: 0.11,
  noisemaker: 0.14,
  bottle: 0.26,
  cans: 0.24,
  plank: 0.5,
  scrap: 0.2,
  chem: 0.16,
  battery: 0.1,
  key: 0.08,
  toolbox: 0.38,
  "car-battery": 0.32,
  flashlight: 0.2,
  pistol: 0.2,
  fuel: 0.26,
  "pressure-tank": 0.38,
  flamethrower: 0.6,
  dynamite: 0.22,
  firecrackers: 0.2,
  molotov: 0.3,
  "flare-gun": 0.2,
  "bear-trap": 0.5,
  "bolt-cutters": 0.45,
}

export function buildItemMeshes(): Record<string, Mesh> {
  const out: Record<string, Mesh> = {}
  const brass = hex(0xc49a4a)

  const ammo = new Mesh()
  ammo.box(-0.085, 0, -0.05, 0.085, 0.07, 0.05, hex(0x4e5a34), MAT.lit, 0, hex(0x5a683c))
  ammo.box(-0.07, 0.07, -0.035, 0.07, 0.078, 0.035, hex(0x3e4828))
  for (let i = 0; i < 4; i++) ammo.prism(-0.05 + i * 0.033, 0.0, 0.011, 0.011, 0.07, 0.088, 6, brass, MAT.shiny)
  out.ammo = ammo

  const medkit = new Mesh()
  medkit.bevelBox(-0.12, 0, -0.08, 0.12, 0.09, 0.08, 0.012, hex(0xd8d4c8), hex(0xe8e4d8))
  medkit.box(-0.018, 0.09, -0.055, 0.018, 0.094, 0.055, hex(0xb02a24), MAT.glow)
  medkit.box(-0.055, 0.09, -0.018, 0.055, 0.094, 0.018, hex(0xb02a24), MAT.glow)
  medkit.box(-0.03, 0.09, -0.085, 0.03, 0.105, -0.075, hex(0x8a8a84))
  out.medkit = medkit

  const bandage = new Mesh()
  bandage.prism(0, 0, 0.045, 0.045, 0, 0.07, 10, hex(0xe6dfcc), MAT.cloth)
  bandage.prism(0, 0, 0.016, 0.016, 0.0, 0.072, 8, hex(0x9a9282))
  bandage.box(0.03, 0, -0.012, 0.09, 0.006, 0.012, hex(0xe6dfcc), MAT.cloth)
  out.bandage = bandage

  const lure = new Mesh()
  lure.prism(0, 0, 0.055, 0.055, 0.0, 0.05, 12, hex(0xa83a2a), MAT.shiny)
  lure.prism(0, 0, 0.044, 0.044, 0.05, 0.053, 12, hex(0xe8e0c8), MAT.lit)
  for (const s of [-1, 1]) lure.prism(s * 0.035, -0.02, 0.022, 0.022, 0.05, 0.075, 8, hex(0xc8b070), MAT.shiny)
  out.noisemaker = lure

  // An empty bottle lying on its side, neck along +x.
  const bottle = new Mesh()
  const green = hex(0x2f5a34)
  bottle.yawBox(-0.04, 0, 0.15, 0.065, 0, 0.065, 0, green, MAT.glass)
  bottle.yawBox(0.06, 0, 0.05, 0.045, 0.01, 0.055, 0, green, MAT.glass)
  bottle.yawBox(0.105, 0, 0.04, 0.026, 0.02, 0.046, 0, green, MAT.glass)
  bottle.yawBox(-0.06, 0, 0.07, 0.068, 0.012, 0.054, 0, hex(0xb8ad8a), MAT.lit)
  out.bottle = bottle

  // Three tin cans tied along a length of wire, ready to string across a doorway.
  const cans = new Mesh()
  cans.box(-0.12, 0.002, -0.004, 0.12, 0.008, 0.004, hex(0x8a8c88), MAT.shiny)
  for (const [x, z] of [[-0.075, 0.04], [0, -0.035], [0.075, 0.035]] as const) {
    cans.prism(x, z, 0.03, 0.03, 0, 0.085, 10, hex(0x9aa0a2), MAT.shiny)
    cans.prism(x, z, 0.027, 0.027, 0.085, 0.088, 10, hex(0x6e7270), MAT.shiny)
    cans.prism(x, z, 0.031, 0.031, 0.03, 0.055, 10, hex(0xa8442c), MAT.lit)
  }
  out.cans = cans

  const plank = new Mesh()
  plank.box(-0.25, 0, -0.05, 0.25, 0.028, 0.05, hex(0x8e6f48), MAT.timber, 0, hex(0x9a7a50))
  plank.box(-0.21, 0.028, -0.01, -0.19, 0.034, 0.01, hex(0x353738), MAT.shiny)
  out.plank = plank

  const scrap = new Mesh()
  scrap.yawBox(-0.04, 0.0, 0.12, 0.05, 0, 0.018, 0.4, hex(0x6e7478), MAT.shiny)
  scrap.yawBox(0.05, 0.02, 0.08, 0.03, 0, 0.025, -0.7, hex(0x8a6a4a), MAT.shiny)
  scrap.prism(0.02, -0.035, 0.03, 0.03, 0, 0.055, 8, hex(0x9aa0a4), MAT.shiny)
  for (let i = 0; i < 3; i++) scrap.yawBox(-0.08 + i * 0.03, 0.04, 0.05, 0.006, 0, 0.006, 0.3 * i, hex(0xb0b4b8), MAT.shiny)
  out.scrap = scrap

  const chem = new Mesh()
  chem.prism(-0.03, 0, 0.034, 0.034, 0, 0.12, 8, hex(0x5a3416), MAT.glass)
  chem.prism(-0.03, 0, 0.034, 0.014, 0.12, 0.15, 8, hex(0x5a3416), MAT.glass)
  chem.prism(-0.03, 0, 0.012, 0.012, 0.15, 0.17, 6, hex(0x2a2a28))
  chem.yawBox(0.05, 0.01, 0.07, 0.06, 0, 0.022, 0.3, hex(0xc8c0a8), MAT.cloth)
  out.chem = chem

  const battery = new Mesh()
  for (const dz of [-0.022, 0.022]) {
    battery.prism(0, dz, 0.02, 0.02, 0, 0.062, 8, hex(0x2a2e30), MAT.shiny)
    battery.prism(0, dz, 0.02, 0.02, 0.062, 0.07, 8, hex(0xc08a3a), MAT.shiny)
  }
  out.battery = battery

  const key = new Mesh()
  key.prism(-0.025, 0, 0.018, 0.018, 0, 0.006, 8, brass, MAT.shiny)
  key.box(-0.01, 0, -0.005, 0.045, 0.006, 0.005, brass, MAT.shiny)
  key.box(0.03, 0, 0.005, 0.04, 0.006, 0.014, brass, MAT.shiny)
  out.key = key

  const toolbox = new Mesh()
  toolbox.bevelBox(-0.19, 0, -0.08, 0.19, 0.14, 0.08, 0.01, hex(0xa82820), hex(0xc0302a), MAT.shiny)
  toolbox.box(-0.19, 0.1, -0.082, 0.19, 0.11, 0.082, hex(0x5a1410), MAT.shiny)
  toolbox.box(-0.09, 0.14, -0.012, 0.09, 0.17, 0.012, hex(0x222426), MAT.shiny)
  out.toolbox = toolbox

  const car = new Mesh()
  car.bevelBox(-0.16, 0, -0.1, 0.16, 0.18, 0.1, 0.01, hex(0x1c1e20), hex(0x2a2c2e), MAT.shiny)
  car.prism(-0.1, -0.05, 0.02, 0.02, 0.18, 0.21, 8, hex(0xb02a24), MAT.shiny)
  car.prism(0.1, -0.05, 0.02, 0.02, 0.18, 0.21, 8, hex(0x9aa0a4), MAT.shiny)
  car.box(-0.14, 0.12, 0.101, 0.14, 0.15, 0.104, hex(0xd8b040), MAT.glow)
  out["car-battery"] = car

  const flashlight = new Mesh()
  flashlight.prism(0, 0, 0.022, 0.022, 0, 0.014, 8, hex(0x2a2c2e), MAT.shiny)
  flashlight.box(-0.1, 0, -0.018, 0.06, 0.036, 0.018, hex(0x2a2c2e), MAT.shiny)
  flashlight.box(0.06, -0.004, -0.026, 0.1, 0.044, 0.026, hex(0x4a4c4e), MAT.shiny)
  out.flashlight = flashlight

  const pistol = new Mesh()
  pistol.box(-0.1, 0, -0.02, 0.1, 0.035, 0.02, hex(0x3a3f42), MAT.actor)
  pistol.box(-0.09, 0, 0.02, -0.03, 0.03, 0.08, hex(0x2b2d2f), MAT.actor)
  out.pistol = pistol

  // Melee weapons lie flat: the held meshes, rolled onto their side.
  const weapons = buildMeleeWeaponMeshes(0)
  for (const id of MELEE_WEAPON_IDS) out[id] = weapons[id]
  Object.assign(out, buildFireItemMeshes())
  out["bolt-cutters"] = boltCuttersMesh()
  return out
}

export function registerItemModels(renderer: Pick<Renderer, "addModel">): ItemModels {
  const ids = new Map<string, number>()
  for (const [item, mesh] of Object.entries(buildItemMeshes())) ids.set(item, renderer.addModel(mesh))
  return {
    model: (item) => ids.get(item),
    footprint: (item) => FOOTPRINT[item] ?? 0.62,
  }
}

/** Melee weapons are modelled held (blade up); lying down they roll onto their flat side. */
export const isLongItem = (item: string) => (MELEE_WEAPON_IDS as readonly string[]).includes(item)

/** Bolt cutters lying flat (the Way Out's chained gates): two red-gripped handles, short steel jaws. */
function boltCuttersMesh(): Mesh {
  const m = new Mesh()
  const steel = hex(0x5c6064)
  for (const s of [-1, 1]) {
    m.yawBox(0.02, s * 0.04, 0.42, 0.025, 0, 0.03, s * 0.12, steel, MAT.shiny)
    m.yawBox(-0.13, s * 0.06, 0.18, 0.04, 0, 0.035, s * 0.12, hex(0xa02a1e), MAT.lit)
    m.yawBox(0.25, s * 0.012, 0.08, 0.03, 0, 0.032, s * -0.2, hex(0x3a3c3e), MAT.shiny)
  }
  return m
}
